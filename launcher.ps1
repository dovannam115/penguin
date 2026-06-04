# Penguin launcher - modern WPF splash + background server startup.
# Entry points:
#   - launcher.vbs (silent - no cmd flash)
#   - start.bat (legacy - wraps the vbs)
$ErrorActionPreference = "Stop"
$projectDir = $PSScriptRoot

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

. (Join-Path $PSScriptRoot "aumid.ps1")

# One-time rename: legacy %LOCALAPPDATA%\AgentCrew → AgentP. Preserves the
# Edge profile (cookies, login session). The AUMID cache is dropped because
# AUMID embeds the profile path and would be stale at the new location.
$legacyAppDir = Join-Path $env:LOCALAPPDATA "AgentCrew"
$newAppDir = Join-Path $env:LOCALAPPDATA "AgentP"
if ((Test-Path $legacyAppDir) -and (-not (Test-Path $newAppDir))) {
    try {
        # Edge holds locks on the user-data-dir while running. Kill any --app
        # window pointed at the old profile before the rename can succeed.
        Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -match [regex]::Escape("--user-data-dir=$legacyAppDir\EdgeProfile")
            } |
            ForEach-Object {
                try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
            }
        Start-Sleep -Milliseconds 800
        Rename-Item -Path $legacyAppDir -NewName "AgentP" -ErrorAction Stop
        $staleAumid = Join-Path $newAppDir "edge-aumid.txt"
        if (Test-Path $staleAumid) { Remove-Item $staleAumid -Force -ErrorAction SilentlyContinue }
    } catch {
        # Rename can fail if locks persist - new session falls through to a
        # fresh AgentP\ dir; user re-logs in once. Not fatal.
    }
}

# ─── Helpers ──────────────────────────────────────────────────────────────

function Test-Port {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(150, $false)
        return ($ok -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Get-AgentPBrowser {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-AgentPEdgeArgs {
    # Dedicated user-data-dir → app gets its own taskbar identity (not grouped
    # under Edge browser). --no-first-run / --no-default-browser-check stop the
    # fresh-profile welcome bubble from showing on first launch.
    $profileDir = Join-Path $env:LOCALAPPDATA "AgentP\EdgeProfile"
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }
    return @(
        "--app=http://localhost:3000",
        "--user-data-dir=$profileDir",
        "--no-first-run",
        "--no-default-browser-check"
    )
}

function Format-ShortcutArgs {
    param([string[]]$ArgList)
    # WScript.Shell shortcut Arguments is a single string. Quote any value with
    # spaces so Edge parses it as one flag.
    return ($ArgList | ForEach-Object {
        if ($_ -match ' ') {
            $eq = $_.IndexOf('=')
            if ($eq -gt 0) { $_.Substring(0, $eq + 1) + '"' + $_.Substring($eq + 1) + '"' }
            else { '"' + $_ + '"' }
        } else { $_ }
    }) -join ' '
}

function Find-OtherAgentPInstalls {
    # Returns sibling Penguin / legacy Agent P install folders under Desktop /
    # Documents / Downloads / parent of $Self, sorted by office.db mtime desc.
    # Used by Invoke-DataMigration to find a populated .data to migrate from
    # when the user unzips a new pack into a new folder instead of overlaying
    # the existing install. Accepts the historical folder names so users coming
    # from Agent P or earlier MAS builds still get their chat history migrated.
    param([string]$Self)
    $roots = @(
        "$env:USERPROFILE\Desktop",
        "$env:USERPROFILE\Documents",
        "$env:USERPROFILE\Downloads",
        (Split-Path $Self -Parent)
    ) | Sort-Object -Unique
    $out = @()
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $n = $_.Name
                $n -like 'Penguin*' -or
                $n -like 'AGENT-P*' -or $n -like 'Agent P*' -or
                $n -like 'mas-ai-office-*' -or
                $n -like 'agent-crew*' -or $n -like 'Agent Crew*'
            } |
            ForEach-Object {
                if ([IO.Path]::GetFullPath($_.FullName) -ieq [IO.Path]::GetFullPath($Self)) { return }
                $db = Join-Path $_.FullName '.data\office.db'
                if (Test-Path $db) {
                    $fi = Get-Item $db
                    $out += [PSCustomObject]@{
                        Path    = $_.FullName
                        DbMtime = $fi.LastWriteTime
                        DbSize  = $fi.Length
                    }
                }
            }
    }
    return @($out | Sort-Object DbMtime -Descending)
}

function Invoke-DataMigration {
    # First-launch self-migration: if this install has no real .data but a
    # sibling install does, copy .data + password-backup.txt over so the new
    # install picks up chat history / files / login automatically. Idempotent
    # via .migrated marker file; never overwrites a populated .data.
    # Returns source path on migration, $null otherwise.
    param([string]$Self)
    $marker = Join-Path $Self '.migrated'
    if (Test-Path $marker) { return $null }

    $threshold = 50KB  # office.db < this = effectively empty (schema only)
    $myDb = Join-Path $Self '.data\office.db'
    $myDbSize = if (Test-Path $myDb) { (Get-Item $myDb).Length } else { 0 }
    if ($myDbSize -ge $threshold) {
        "skipped: self db is $myDbSize bytes ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))" |
            Out-File $marker -Encoding utf8
        return $null
    }

    $others = Find-OtherAgentPInstalls -Self $Self
    $src = $others | Where-Object { $_.DbSize -ge $threshold } | Select-Object -First 1
    if (-not $src) {
        "skipped: no sibling install with populated .data ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))" |
            Out-File $marker -Encoding utf8
        return $null
    }

    # Kill any process holding port 3000 - it would be the source install's
    # server, holding SQLite WAL locks on the file we're about to copy.
    $conns = netstat -ano | Select-String ":3000\s.*LISTENING"
    foreach ($line in $conns) {
        $cols = ($line.ToString() -split '\s+') | Where-Object { $_ }
        $existingPid = $cols[-1]
        if ($existingPid -match '^\d+$') {
            try { Stop-Process -Id ([int]$existingPid) -Force -ErrorAction Stop } catch { }
        }
    }
    Start-Sleep -Milliseconds 800

    $srcData = Join-Path $src.Path '.data'
    $dstData = Join-Path $Self '.data'
    # Safety: if dst exists (small db), move aside rather than delete - user can
    # manually recover if migration corrupts something.
    if (Test-Path $dstData) {
        $bak = "$dstData.pre-migrate-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        try { Move-Item $dstData $bak -Force -ErrorAction Stop } catch {
            Remove-Item $dstData -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Copy-Item $srcData $dstData -Recurse -Force

    $srcPwd = Join-Path $src.Path 'password-backup.txt'
    $dstPwd = Join-Path $Self 'password-backup.txt'
    if ((Test-Path $srcPwd) -and (-not (Test-Path $dstPwd))) {
        Copy-Item $srcPwd $dstPwd -Force
    }

    "migrated from: $($src.Path) at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (src db $($src.DbSize) bytes)" |
        Out-File $marker -Encoding utf8
    return $src.Path
}

function Ensure-Shortcuts {
    param([string]$ProjectDir)
    # Shortcuts target wscript.exe + open.vbs so a single click does the right
    # thing in both states:
    #   - Server already running → open.ps1 opens the browser straight away.
    #   - Server dead (e.g. fresh boot) → open.ps1 hands off to launcher.vbs
    #     which shows the splash and boots the dev server first.
    # The previous design targeted msedge.exe directly, which broke after a
    # reboot - Edge would launch but localhost was unreachable. Taskbar
    # grouping with the live --app window is preserved by Sync-AgentPAumid
    # below, which stamps Edge's auto-generated AUMID onto the .lnk.
    $iconAbs = Join-Path $ProjectDir "public\app-icon.ico"
    $openVbs = Join-Path $ProjectDir "open.vbs"
    if (-not (Test-Path $openVbs)) { return }

    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    $argsStr = '"' + $openVbs + '"'
    $sh = New-Object -ComObject WScript.Shell

    $locations = @(
        "$env:USERPROFILE\Desktop\Penguin.lnk",
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Penguin.lnk",
        # Pinned copies (only updated if the user has already pinned them).
        # Keep refreshing the legacy "Agent P.lnk" / "Agent Crew.lnk" pins so
        # existing taskbar pins keep working after the rename - the pin registry
        # references them by filename, deleting would orphan the pin.
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Penguin.lnk",
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Agent P.lnk",
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Agent Crew.lnk"
    )
    foreach ($lnk in $locations) {
        try {
            $parent = Split-Path $lnk -Parent
            $isPinned = $lnk -like "*\User Pinned\TaskBar\*"
            if ($isPinned -and -not (Test-Path $lnk)) { continue }
            if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            $sc = $sh.CreateShortcut($lnk)
            $sc.TargetPath = $wscript
            $sc.Arguments = $argsStr
            $sc.WorkingDirectory = $ProjectDir
            $sc.IconLocation = "$iconAbs,0"
            $sc.Description = "Penguin - Multi-Agent Workspace"
            $sc.Save()
        } catch { }
    }

    # Apply previously detected AUMID (if any) so a freshly-created shortcut
    # already matches the running window's identity. Sync-AgentPAumid below
    # refreshes this once the window is actually up.
    $cached = Get-AgentPCachedAumid
    if ($cached) { Set-AgentPShortcutsAumid -Aumid $cached }

    # Cleanup old shortcut names from earlier builds (MAS → Agent Crew → Agent P → Penguin).
    # Pinned-taskbar shortcuts are intentionally NOT removed - pin registry
    # references them directly, so deleting orphans the pin.
    $legacyLnks = @(
        "$env:USERPROFILE\Desktop\MAS - AI Office.lnk",
        "$env:USERPROFILE\Desktop\Agent Crew.lnk",
        "$env:USERPROFILE\Desktop\Agent P.lnk",
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\MAS - AI Office.lnk",
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Agent Crew.lnk",
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Agent P.lnk"
    )
    foreach ($old in $legacyLnks) {
        if (Test-Path $old) {
            try { Remove-Item $old -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}

# ─── XAML / Window ────────────────────────────────────────────────────────

$xamlStr = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Penguin"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize"
        Width="480" Height="340"
        ShowInTaskbar="False"
        Topmost="True"
        Opacity="0">
  <Window.Resources>
    <Style TargetType="Button" x:Key="GhostBtn">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Foreground" Value="#99FFFFFF"/>
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="Transparent" CornerRadius="8">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#22FFFFFF"/>
                <Setter Property="Foreground" Value="#FFFFFFFF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ProgressBar" x:Key="ThinBar">
      <Setter Property="Height" Value="5"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Background" Value="#FF1A1A1A"/>
      <Setter Property="Foreground" Value="#FF38BDF8"/>
      <Setter Property="Minimum" Value="0"/>
      <Setter Property="Maximum" Value="100"/>
      <Setter Property="Value" Value="0"/>
    </Style>
  </Window.Resources>

  <Border CornerRadius="14" BorderBrush="#FF3F3F3F" BorderThickness="1">
    <Border.Background>
      <RadialGradientBrush GradientOrigin="0.5,-0.05" Center="0.5,-0.05" RadiusX="1.1" RadiusY="0.95">
        <GradientStop Color="#FF2F2F2D" Offset="0"/>
        <GradientStop Color="#FF262624" Offset="0.55"/>
        <GradientStop Color="#FF1F1F1D" Offset="1"/>
      </RadialGradientBrush>
    </Border.Background>
    <Border.Effect>
      <DropShadowEffect Color="#FF0EA5E9" ShadowDepth="0" BlurRadius="36" Opacity="0.35"/>
    </Border.Effect>

    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="36"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="64"/>
      </Grid.RowDefinitions>

      <!-- Title bar (drag + close) -->
      <Grid Grid.Row="0" x:Name="dragBar" Background="Transparent">
        <Button x:Name="btnClose" Content="✕" Style="{StaticResource GhostBtn}"
                HorizontalAlignment="Right" Width="36" Height="28" Margin="0,4,4,0"
                ToolTip="Close"/>
      </Grid>

      <!-- Penguin mascot (bob + sway + soft sheen) -->
      <StackPanel Grid.Row="1" VerticalAlignment="Center" HorizontalAlignment="Center"
                  x:Name="brandPanel" Opacity="0">
        <StackPanel.RenderTransform>
          <TranslateTransform Y="10"/>
        </StackPanel.RenderTransform>

        <Grid Width="156" Height="166">
          <!-- ground shadow that breathes with the bob -->
          <Ellipse x:Name="pShadow" Width="120" Height="20"
                   HorizontalAlignment="Center" VerticalAlignment="Bottom" Margin="0,0,0,4"
                   RenderTransformOrigin="0.5,0.5">
            <Ellipse.Fill>
              <RadialGradientBrush>
                <GradientStop Color="#660EA5E9" Offset="0"/>
                <GradientStop Color="#000EA5E9" Offset="0.8"/>
              </RadialGradientBrush>
            </Ellipse.Fill>
            <Ellipse.RenderTransform>
              <ScaleTransform x:Name="pShadowScale" ScaleX="1" ScaleY="1"/>
            </Ellipse.RenderTransform>
          </Ellipse>

          <!-- penguin + sheen, bobbing together -->
          <Grid x:Name="penguinGroup" Width="140" Height="140"
                HorizontalAlignment="Center" VerticalAlignment="Top"
                RenderTransformOrigin="0.5,0.92">
            <Grid.RenderTransform>
              <TransformGroup>
                <ScaleTransform x:Name="pScale" ScaleX="1" ScaleY="1"/>
                <RotateTransform x:Name="pRot" Angle="0"/>
                <TranslateTransform x:Name="pTrans" Y="0"/>
              </TransformGroup>
            </Grid.RenderTransform>

            <Grid.Triggers>
              <EventTrigger RoutedEvent="FrameworkElement.Loaded">
                <BeginStoryboard>
                  <Storyboard>
                    <!-- gentle bob -->
                    <DoubleAnimation Storyboard.TargetName="pTrans" Storyboard.TargetProperty="Y"
                                     From="0" To="-8" Duration="0:0:1.4" AutoReverse="True" RepeatBehavior="Forever">
                      <DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                    <!-- gentle sway -->
                    <DoubleAnimation Storyboard.TargetName="pRot" Storyboard.TargetProperty="Angle"
                                     From="-2.2" To="2.2" Duration="0:0:1.4" AutoReverse="True" RepeatBehavior="Forever">
                      <DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                    <!-- pop in -->
                    <DoubleAnimationUsingKeyFrames Storyboard.TargetName="pScale" Storyboard.TargetProperty="ScaleX">
                      <EasingDoubleKeyFrame KeyTime="0:0:0" Value="0.6"/>
                      <EasingDoubleKeyFrame KeyTime="0:0:0.42" Value="1.06"><EasingDoubleKeyFrame.EasingFunction><CubicEase EasingMode="EaseOut"/></EasingDoubleKeyFrame.EasingFunction></EasingDoubleKeyFrame>
                      <EasingDoubleKeyFrame KeyTime="0:0:0.62" Value="1"/>
                    </DoubleAnimationUsingKeyFrames>
                    <DoubleAnimationUsingKeyFrames Storyboard.TargetName="pScale" Storyboard.TargetProperty="ScaleY">
                      <EasingDoubleKeyFrame KeyTime="0:0:0" Value="0.6"/>
                      <EasingDoubleKeyFrame KeyTime="0:0:0.42" Value="1.06"><EasingDoubleKeyFrame.EasingFunction><CubicEase EasingMode="EaseOut"/></EasingDoubleKeyFrame.EasingFunction></EasingDoubleKeyFrame>
                      <EasingDoubleKeyFrame KeyTime="0:0:0.62" Value="1"/>
                    </DoubleAnimationUsingKeyFrames>
                    <!-- shadow pulse (synced with bob) -->
                    <DoubleAnimation Storyboard.TargetName="pShadowScale" Storyboard.TargetProperty="ScaleX"
                                     From="1" To="0.7" Duration="0:0:1.4" AutoReverse="True" RepeatBehavior="Forever">
                      <DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                    <DoubleAnimation Storyboard.TargetName="pShadowScale" Storyboard.TargetProperty="ScaleY"
                                     From="1" To="0.7" Duration="0:0:1.4" AutoReverse="True" RepeatBehavior="Forever">
                      <DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                    <DoubleAnimation Storyboard.TargetName="pShadow" Storyboard.TargetProperty="Opacity"
                                     From="0.8" To="0.45" Duration="0:0:1.4" AutoReverse="True" RepeatBehavior="Forever">
                      <DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                  </Storyboard>
                </BeginStoryboard>
              </EventTrigger>
            </Grid.Triggers>

            <Image Source="__PENGUIN__" Width="140" Height="140" Stretch="Uniform"/>
          </Grid>
        </Grid>
      </StackPanel>

      <!-- Slim boot progress (status text kept for code, hidden for a clean look) -->
      <StackPanel Grid.Row="2" Margin="64,0,64,16" VerticalAlignment="Center">
        <TextBlock x:Name="statusText" Visibility="Collapsed" Text="Preparing environment"
                   FontFamily="Segoe UI" FontSize="11" Foreground="#FFA1A1AA"
                   HorizontalAlignment="Center" Margin="0,0,0,12" TextWrapping="NoWrap"/>
        <ProgressBar x:Name="progressBar" Style="{StaticResource ThinBar}"/>
      </StackPanel>
    </Grid>
  </Border>
</Window>
"@

# Inject absolute font folder URI so XAML can resolve the bundled Changa One TTF.
$fontDirUri = ([System.Uri](Join-Path $projectDir "public\fonts\")).AbsoluteUri
$xamlStr = $xamlStr.Replace("__FONT_DIR__", $fontDirUri)
# Inject absolute URI of the cut-out penguin mascot used on the splash.
$penguinUri = ([System.Uri](Join-Path $projectDir "public\penguin-mascot.png")).AbsoluteUri
$xamlStr = $xamlStr.Replace("__PENGUIN__", $penguinUri)
$reader = New-Object System.Xml.XmlTextReader (New-Object System.IO.StringReader $xamlStr)
$window = [Windows.Markup.XamlReader]::Load($reader)
if (-not $window) {
    [System.Windows.Forms.MessageBox]::Show("Splash window failed to load. See $env:TEMP\agent-p-launcher.log")
    "$(Get-Date -Format 'HH:mm:ss.fff') XAML load returned null" | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
    exit 1
}

$statusText = $window.FindName("statusText")
$btnClose = $window.FindName("btnClose")
$dragBar = $window.FindName("dragBar")
$brandPanel = $window.FindName("brandPanel")
$progressBar = $window.FindName("progressBar")

# Taskbar icon
$icoFile = Join-Path $projectDir "public\app-icon.ico"
if (Test-Path $icoFile) {
    $bi2 = New-Object System.Windows.Media.Imaging.BitmapImage
    $bi2.BeginInit()
    $bi2.UriSource = New-Object System.Uri ($icoFile, [System.UriKind]::Absolute)
    $bi2.CacheOption = "OnLoad"
    $bi2.EndInit()
    $bi2.Freeze()
    $window.Icon = $bi2
}

$btnClose.Add_Click({ $window.Close() })
$dragBar.Add_MouseLeftButtonDown({
    param($s, $e)
    if ($e.LeftButton -eq [System.Windows.Input.MouseButtonState]::Pressed) {
        $window.DragMove()
    }
})

function Set-Status {
    param([string]$Text)
    $window.Dispatcher.Invoke([Action]{ $statusText.Text = $Text })
}

# ─── Smooth fade-in animations ────────────────────────────────────────────

function Start-FadeIn {
    # Window fade
    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation 0.0, 1.0, ([System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(450)))
    $anim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
    $anim.EasingFunction.EasingMode = "EaseOut"
    $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $anim)

    # Brand panel: slide up + fade
    $opacityAnim = New-Object System.Windows.Media.Animation.DoubleAnimation 0.0, 1.0, ([System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(650)))
    $opacityAnim.BeginTime = [TimeSpan]::FromMilliseconds(120)
    $opacityAnim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
    $opacityAnim.EasingFunction.EasingMode = "EaseOut"
    $brandPanel.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $opacityAnim)

    $slideAnim = New-Object System.Windows.Media.Animation.DoubleAnimation 10.0, 0.0, ([System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(650)))
    $slideAnim.BeginTime = [TimeSpan]::FromMilliseconds(120)
    $slideAnim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
    $slideAnim.EasingFunction.EasingMode = "EaseOut"
    $brandPanel.RenderTransform.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $slideAnim)
}

function Start-FadeOutThenOpenApp {
    # Stop the progress timer when we begin fading - the penguin is at 100% by
    # this point (phase 4 jumps fast); no point continuing to tick.
    try { $progressTimer.Stop() } catch { }

    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation 1.0, 0.0, ([System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(350)))
    $anim.EasingFunction = New-Object System.Windows.Media.Animation.CubicEase
    $anim.EasingFunction.EasingMode = "EaseIn"
    $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $anim)

    # $script: scope is required - local vars die before the event fires.
    $script:afterFade = New-Object System.Windows.Threading.DispatcherTimer
    $script:afterFade.Interval = [TimeSpan]::FromMilliseconds(380)
    $script:afterFade.Add_Tick({
        $script:afterFade.Stop()
        try {
            $browser = Get-AgentPBrowser
            $edgeArgs = Get-AgentPEdgeArgs
            if ($browser) {
                Start-Process $browser -ArgumentList $edgeArgs
            } else {
                Start-Process "http://localhost:3000"
            }
            ("$(Get-Date -Format 'HH:mm:ss.fff') browser launched") | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
        } catch {
            ("AFTER-FADE-ERR: " + $_.Exception.Message) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
        }
        $window.Close()
    })
    $script:afterFade.Start()
}

# ─── Startup state machine ────────────────────────────────────────────────

$state = [hashtable]::Synchronized(@{
    phase = 0
    installProc = $null
    portWaitStart = $null
    splashStart = Get-Date
    phaseEntered = Get-Date
    progress = 0.0
})

# Per-phase progress target - penguin marches toward this and waits if the
# phase lingers. Final jump to 100 happens when phase 4 (Ready) fires.
$PhaseProgressTarget = @{
    0  = 15.0
    1  = 30.0
    15 = 80.0
    2  = 90.0
    3  = 95.0
    35 = 98.0
    4  = 100.0
}

# Minimum time splash stays visible after server is ready, so the user
# can actually see the brand instead of a sub-second flash.
$MinSplashSeconds = 5.0
# Each status message stays on screen at least this long before transitioning.
$MinPhaseMs = 1100

function Move-Phase {
    param([double]$Next)
    ("$(Get-Date -Format 'HH:mm:ss.fff') phase " + $state.phase + " -> " + $Next) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
    $state.phase = $Next
    $state.phaseEntered = Get-Date
}

function Phase-Held {
    return ((Get-Date) - $state.phaseEntered).TotalMilliseconds -ge $MinPhaseMs
}

# Slow determinate progress timer. 80ms tick is fast enough to look fluid.
# The bar creeps toward the current phase's target and dashes to 100 when
# phase 4 (Ready) fires.
$progressTimer = New-Object System.Windows.Threading.DispatcherTimer
$progressTimer.Interval = [TimeSpan]::FromMilliseconds(80)
$progressTimer.Add_Tick({
    try {
        $cur = [double]$state.progress
        $target = $PhaseProgressTarget[[double]$state.phase]
        if (-not $target) { $target = 95.0 }
        $isFinal = ($state.phase -ge 4)
        $step = if ($isFinal) { 3.5 } else { 0.55 }
        if ($cur -lt $target) {
            $cur = [Math]::Min($target, $cur + $step)
        }
        $state.progress = $cur
        $progressBar.Value = $cur
    } catch { }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(250)

$timer.Add_Tick({
    try {
        switch ($state.phase) {
            0 {
                Set-Status "Checking environment"
                $node = Get-Command node -ErrorAction SilentlyContinue
                if (-not $node) {
                    Set-Status "Node.js not installed. Download from nodejs.org"
                    $timer.Stop()
                    return
                }
                if (Phase-Held) { Move-Phase 1 }
            }
            1 {
                # Force every launcher run to be a fresh session: kill any
                # previous server still listening on 3000 so npm dev restarts
                # with a new boot-token, requiring the user to re-enter their
                # password (lib/auth.ts rotates the token per Node process).
                $killedAny = $false
                $conns = netstat -ano | Select-String ":3000\s.*LISTENING"
                foreach ($line in $conns) {
                    $cols = ($line.ToString() -split '\s+') | Where-Object { $_ }
                    $existingPid = $cols[-1]
                    if ($existingPid -match '^\d+$') {
                        try {
                            Stop-Process -Id ([int]$existingPid) -Force -ErrorAction Stop
                            $killedAny = $true
                        } catch { }
                    }
                }
                if ($killedAny) {
                    Set-Status "Refreshing session"
                    # brief wait for port to free
                    Start-Sleep -Milliseconds 600
                }
                if (-not (Test-Path (Join-Path $projectDir "node_modules"))) {
                    Set-Status "Installing dependencies (1 to 2 minutes, first run only)"
                    # npm on Windows is npm.cmd, not npm.exe - Start-Process bare
                    # 'npm' fails with "system cannot find all the information
                    # required". Route through cmd /c so PATHEXT resolves it.
                    $state.installProc = Start-Process cmd -ArgumentList "/c","npm install" `
                        -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
                    $state.installStart = Get-Date
                    Move-Phase 15
                } else {
                    Set-Status "Dependencies ready"
                    if (Phase-Held) { Move-Phase 2 }
                }
            }
            15 {
                # Throttle progress polling (1.5s) - file enumeration on a tree
                # being actively written is expensive and would freeze the splash
                # if done every tick.
                $now = Get-Date
                $shouldUpdate = (-not $state.lastProgressCheck) -or `
                    (($now - $state.lastProgressCheck).TotalMilliseconds -gt 1500)
                if ($shouldUpdate) {
                    $state.lastProgressCheck = $now
                    # Read total package target from package-lock.json once.
                    if (-not $state.totalPackages) {
                        $lockPath = Join-Path $projectDir "package-lock.json"
                        $state.totalPackages = 500  # fallback estimate
                        if (Test-Path $lockPath) {
                            try {
                                $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
                                $c = 0
                                foreach ($p in $lock.packages.PSObject.Properties) {
                                    if ($p.Name -ne "") { $c++ }
                                }
                                if ($c -gt 0) { $state.totalPackages = $c }
                            } catch { }
                        }
                    }
                    # Count installed packages: top-level dirs in node_modules,
                    # with scoped (@scope) packages counted as their children.
                    $nm = Join-Path $projectDir "node_modules"
                    $installed = 0
                    if (Test-Path $nm) {
                        try {
                            $top = @(Get-ChildItem $nm -Directory -ErrorAction SilentlyContinue)
                            foreach ($d in $top) {
                                if ($d.Name.StartsWith("@")) {
                                    $installed += @(Get-ChildItem $d.FullName -Directory -ErrorAction SilentlyContinue).Count
                                } else {
                                    $installed++
                                }
                            }
                        } catch { }
                    }
                    $elapsed = [int]((Get-Date) - $state.installStart).TotalSeconds
                    Set-Status "Installing $installed / $($state.totalPackages) packages - ${elapsed}s"
                }
                if ($state.installProc.HasExited) {
                    if ($state.installProc.ExitCode -ne 0) {
                        Set-Status "Install failed. Check Node.js and your network."
                        $timer.Stop()
                        return
                    }
                    Move-Phase 2
                }
            }
            2 {
                Set-Status "Starting server"
                # Hidden so the npm cmd window doesn't flash a taskbar entry
                # behind the splash when the splash closes. Server is stopped
                # via Task Manager (node.exe) or stop.bat.
                # Production mode (next start) - assumes pack.ps1 ran `next build`
                # so .next/ is shipped pre-compiled. No per-route compile delay
                # on first hit. Falls back to dev mode if no production build is
                # present. Check BUILD_ID specifically (not just .next/) because
                # `next dev` also creates .next/dev/ but without BUILD_ID - using
                # `next start` against that just errors out and leaves the splash
                # stuck waiting for port 3000.
                $buildIdFile = Join-Path $projectDir ".next\BUILD_ID"
                if (Test-Path $buildIdFile) {
                    $cmdLine = "npm start"
                } else {
                    $cmdLine = "npm run dev"
                }
                Start-Process cmd -ArgumentList "/c",$cmdLine `
                    -WorkingDirectory $projectDir -WindowStyle Hidden | Out-Null
                $state.portWaitStart = Get-Date
                Move-Phase 3
            }
            3 {
                if (Test-Port 3000) {
                    if (Phase-Held) { Move-Phase 35 }
                } elseif (((Get-Date) - $state.portWaitStart).TotalSeconds -gt 90) {
                    Set-Status "Server is taking longer than expected. Still waiting."
                }
            }
            35 {
                # Warm up the login route so Next.js compiles it now (during the
                # splash) instead of after the browser opens (which would leave
                # the user staring at a blank Edge window for 5 to 10 seconds).
                Set-Status "Warming up routes"
                if (-not $state.warmupStarted) {
                    $state.warmupStarted = $true
                    $state.warmupStart = Get-Date
                    try {
                        $wc = New-Object System.Net.WebClient
                        $wc.Add_DownloadStringCompleted({ $state.warmupDone = $true })
                        $wc.DownloadStringAsync([System.Uri]"http://localhost:3000/login")
                    } catch {
                        $state.warmupDone = $true
                    }
                }
                $waited = ((Get-Date) - $state.warmupStart).TotalSeconds
                if ($state.warmupDone -or $waited -gt 25) {
                    if (Phase-Held) { Move-Phase 4 }
                }
            }
            4 {
                Set-Status "Ready. Launching app."
                $timer.Stop()
                # Let the progress timer keep running so the penguin pushes the
                # bar from wherever it is up to 100% on screen, then we fade.

                # Hold splash long enough for the user to actually see it,
                # then fade out and only open the browser after fade completes.
                # Use $script: scope so the timer survives this handler returning.
                $elapsed = ((Get-Date) - $state.splashStart).TotalSeconds
                $remainingMs = [int][Math]::Max(1400, ($MinSplashSeconds - $elapsed) * 1000)

                $script:closer = New-Object System.Windows.Threading.DispatcherTimer
                $script:closer.Interval = [TimeSpan]::FromMilliseconds($remainingMs)
                $script:closer.Add_Tick({
                    $script:closer.Stop()
                    Start-FadeOutThenOpenApp
                })
                $script:closer.Start()
            }
        }
    } catch {
        ("TICK-ERR phase=" + $state.phase + " msg=" + $_.Exception.Message + " stack=" + $_.ScriptStackTrace) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
        $timer.Stop()
    }
})

$window.Add_Loaded({
    try {
        "$(Get-Date -Format 'HH:mm:ss.fff') Loaded fired" | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
        Start-FadeIn
        # Migrate before Ensure-Shortcuts: if user unzipped to a brand-new
        # folder, copy .data + password-backup from the previous install so
        # this launch picks up their chat history and login.
        try {
            $statusText.Text = "Checking for previous install"
            $migratedFrom = Invoke-DataMigration -Self $projectDir
            if ($migratedFrom) {
                $statusText.Text = "Migrated chat history from previous install"
                "$(Get-Date -Format 'HH:mm:ss.fff') migrated from $migratedFrom" |
                    Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
            }
        } catch {
            ("MIGRATE-ERR: " + $_.Exception.Message) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
        }
        Ensure-Shortcuts -ProjectDir $projectDir

        # Supervisor-pattern update apply. If the previous Penguin session
        # queued an update via Settings > Update > Restart, the server dropped
        # a .update-pending marker before exiting. We do the swap here, inside
        # the splash, before starting the new server - clean UI, no terminal
        # flash, no fragile detached spawn from Node.
        $marker = Join-Path $projectDir '.update-pending'
        if (Test-Path $marker) {
            try {
                $info = Get-Content $marker -Raw -ErrorAction Stop | ConvertFrom-Json
                $stagedDir = $info.stagedDir
                if ($stagedDir -and (Test-Path $stagedDir)) {
                    $statusText.Text = "Applying update"
                    "$(Get-Date -Format 'HH:mm:ss.fff') apply: marker found, stagedDir=$stagedDir" |
                        Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8

                    # Wipe stale .next so the new compiled bundle is the only
                    # thing the next `next start` loads (otherwise a partial
                    # robocopy could leave old chunks mixed with new).
                    $oldNext = Join-Path $projectDir '.next'
                    if (Test-Path $oldNext) {
                        try { Remove-Item $oldNext -Recurse -Force -ErrorAction Stop } catch {
                            "$(Get-Date -Format 'HH:mm:ss.fff') apply: .next wipe failed: $($_.Exception.Message)" |
                                Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
                        }
                    }

                    # Robocopy staged -> install. Exclude user data, the
                    # staging dir, the marker itself, password-backup, and any
                    # stray log files.
                    $statusText.Text = "Copying new files"
                    $skipNm = Test-Path (Join-Path $projectDir '.update-staging\.skip-node-modules')
                    $excludeDirs = @(
                        (Join-Path $projectDir '.data'),
                        (Join-Path $projectDir '.update-staging')
                    )
                    if ($skipNm) {
                        $excludeDirs += (Join-Path $projectDir 'node_modules')
                    }
                    $null = robocopy $stagedDir $projectDir /E /MT:16 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP `
                        /XD $excludeDirs `
                        /XF .update-pending password-backup.txt *.log .last-update-source-list.txt
                    "$(Get-Date -Format 'HH:mm:ss.fff') apply: robocopy exit=$LASTEXITCODE" |
                        Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8

                    # Cleanup: drop marker + staging dir.
                    try { Remove-Item $marker -Force -ErrorAction Stop } catch { }
                    $staging = Join-Path $projectDir '.update-staging'
                    if (Test-Path $staging) {
                        try { Remove-Item $staging -Recurse -Force -ErrorAction Stop } catch { }
                    }

                    # Confirm by re-reading the on-disk version.
                    try {
                        $newVer = (Get-Content (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json).version
                        $statusText.Text = "Updated to v$newVer"
                        "$(Get-Date -Format 'HH:mm:ss.fff') apply: now v$newVer" |
                            Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
                    } catch { }
                } else {
                    "$(Get-Date -Format 'HH:mm:ss.fff') apply: stagedDir missing, skipping" |
                        Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
                    try { Remove-Item $marker -Force -ErrorAction SilentlyContinue } catch { }
                }
            } catch {
                ("APPLY-UPDATE-ERR: " + $_.Exception.Message + " :: " + $_.ScriptStackTrace) |
                    Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
                # Don't let an apply failure block the launcher - server still
                # boots on the previous version so the user can re-try.
                try { Remove-Item $marker -Force -ErrorAction SilentlyContinue } catch { }
            }
        }

        $progressTimer.Start()
        $timer.Start()
        "$(Get-Date -Format 'HH:mm:ss.fff') Loaded complete" | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
    } catch {
        ("LOADED-ERR: " + $_.Exception.Message + " :: " + $_.ScriptStackTrace) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
    }
})

try {
    "$(Get-Date -Format 'HH:mm:ss.fff') Calling ShowDialog. window null? $($null -eq $window)" | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
    [void]$window.ShowDialog()
    "$(Get-Date -Format 'HH:mm:ss.fff') ShowDialog returned" | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
} catch {
    ("SHOW-ERR: " + $_.Exception.Message + " :: " + $_.ScriptStackTrace) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
}

# After the splash is gone, hunt down the live Edge --app window, read its
# auto-generated AUMID, and stamp it onto our Desktop / Start Menu / pinned
# shortcuts. This is what merges the pinned taskbar button into the same
# group as the running window (so the user sees one icon, not two).
try {
    $aumid = Sync-AgentPAumid -TimeoutMs 12000
    $aumidStr = if ($aumid) { $aumid } else { "<none>" }
    ("$(Get-Date -Format 'HH:mm:ss.fff') aumid=" + $aumidStr) |
        Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
} catch {
    ("AUMID-SYNC-ERR: " + $_.Exception.Message) | Out-File "$env:TEMP\agent-p-launcher.log" -Append -Encoding utf8
}
