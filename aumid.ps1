# Agent P - AppUserModelID helpers.
# Edge in --app=URL mode computes its own AUMID (derived from URL + profile
# path). Without the same AUMID on our .lnk shortcut, Windows treats the
# pinned button and the running --app window as two separate apps and shows
# two taskbar buttons. These helpers read the live window's AUMID and stamp
# it onto the shortcut so they merge into one button.

if (-not ('AgentPAumid' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentPAumid {
    [DllImport("shell32.dll", PreserveSig = false)]
    public static extern void SHGetPropertyStoreForWindow(
        IntPtr hwnd, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT {
        public ushort vt;
        public ushort r1, r2, r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("0000010B-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName,
                  [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile(out IntPtr ppszFileName);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class CShellLink {}

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT pv);

    static readonly Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    static PROPERTYKEY PKEY_AppUserModel_ID = new PROPERTYKEY {
        fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
        pid = 5
    };

    public static string GetWindowAumid(IntPtr hwnd) {
        Guid iid = IID_IPropertyStore;
        IPropertyStore store = null;
        SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
        if (store == null) return null;
        PROPVARIANT pv;
        var key = PKEY_AppUserModel_ID;
        int hr = store.GetValue(ref key, out pv);
        string result = null;
        if (hr >= 0 && pv.vt == 31 && pv.p != IntPtr.Zero) {
            result = Marshal.PtrToStringUni(pv.p);
        }
        PropVariantClear(ref pv);
        Marshal.ReleaseComObject(store);
        return result;
    }

    public static IntPtr FindTopLevelWindowByPid(uint pid, string classNamePrefix) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) => {
            uint windowPid;
            GetWindowThreadProcessId(hwnd, out windowPid);
            if (windowPid != pid) return true;
            if (!IsWindowVisible(hwnd)) return true;
            // Skip child/owned popup windows.
            if (GetWindow(hwnd, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
            if (classNamePrefix != null) {
                var sb = new StringBuilder(256);
                GetClassName(hwnd, sb, 256);
                if (!sb.ToString().StartsWith(classNamePrefix)) return true;
            }
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static void SetShortcutAumid(string lnkPath, string aumid) {
        var link = new CShellLink();
        try {
            ((IPersistFile)link).Load(lnkPath, 2 /* STGM_READWRITE */);
            var store = (IPropertyStore)link;
            var key = PKEY_AppUserModel_ID;
            var pv = new PROPVARIANT { vt = 31 /* VT_LPWSTR */ };
            pv.p = Marshal.StringToCoTaskMemUni(aumid);
            try {
                int hr = store.SetValue(ref key, ref pv);
                if (hr < 0) throw Marshal.GetExceptionForHR(hr);
                hr = store.Commit();
                if (hr < 0) throw Marshal.GetExceptionForHR(hr);
            } finally {
                PropVariantClear(ref pv);
            }
            ((IPersistFile)link).Save(lnkPath, true);
        } finally {
            Marshal.FinalReleaseComObject(link);
        }
    }
}
"@
}

$Global:AgentPAumidCachePath = Join-Path $env:LOCALAPPDATA "AgentP\edge-aumid.txt"

function Get-AgentPCachedAumid {
    if (Test-Path $Global:AgentPAumidCachePath) {
        try {
            $v = (Get-Content $Global:AgentPAumidCachePath -Raw -ErrorAction Stop).Trim()
            if ($v) { return $v }
        } catch { }
    }
    return $null
}

function Save-AgentPCachedAumid {
    param([string]$Aumid)
    if (-not $Aumid) { return }
    $dir = Split-Path $Global:AgentPAumidCachePath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $Aumid | Out-File -FilePath $Global:AgentPAumidCachePath -Encoding utf8 -Force
}

function Set-AgentPShortcutsAumid {
    param([string]$Aumid)
    if (-not $Aumid) { return }
    $lnks = @(
        "$env:USERPROFILE\Desktop\Penguin.lnk",
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Penguin.lnk",
        # Pinned copies live in this folder once the user pins them. Updating
        # all known names means re-pinning isn't required after a rename.
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Penguin.lnk",
        # Legacy pinned shortcuts from earlier brand names - pin registry still
        # points at these filenames, so we update their AUMID + description in
        # place rather than recreate (which would break the pin).
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Agent P.lnk",
        "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Agent Crew.lnk"
    )
    foreach ($lnk in $lnks) {
        if (Test-Path $lnk) {
            try { [AgentPAumid]::SetShortcutAumid($lnk, $Aumid) } catch { }
        }
    }
}

function Sync-AgentPAumid {
    # Polls for the live Edge --app window, reads its AUMID, writes it to the
    # cache and stamps it onto all known Agent P shortcuts (incl. the pinned
    # copy). Returns the AUMID, or $null on timeout.
    param([int]$TimeoutMs = 10000)
    $profileDir = Join-Path $env:LOCALAPPDATA "AgentP\EdgeProfile"
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -match '--app=http://localhost:3000' -and
                $_.CommandLine -match [regex]::Escape("--user-data-dir=$profileDir")
            }
        foreach ($p in $procs) {
            try {
                $hwnd = [AgentPAumid]::FindTopLevelWindowByPid([uint32]$p.ProcessId, "Chrome_WidgetWin_")
                if ($hwnd -ne [IntPtr]::Zero) {
                    $aumid = [AgentPAumid]::GetWindowAumid($hwnd)
                    if ($aumid) {
                        Save-AgentPCachedAumid -Aumid $aumid
                        Set-AgentPShortcutsAumid -Aumid $aumid
                        return $aumid
                    }
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 250
    }
    return $null
}
