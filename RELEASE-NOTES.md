Penguin Release Notes


v2.3.0

Excel data hygiene skill upgraded for every employee
- Every employee now has the Excel skill auto-attached on next launch. Previously only Atlas had it; on existing installs a one-time migration runs and adds it to Aria, Scout, Forge, and any custom employee you created.
- The skill content was rewritten to follow Anthropic's xlsx hard rules. It now enforces zero formula errors on output (no #REF!, #DIV/0!, #VALUE!, #N/A, #NAME?), preserve existing template conventions when editing files like Tool_DT.xlsm, use formulas instead of hardcoded computed values so the file recalculates when inputs change, and a verification checklist before handing off.
- Number formatting standards added: currency #,##0 with units in the header, negatives in parentheses, zero rendered as a dash, percentages 0.0%, multiples 0.0x, years as text, dates ISO yyyy-mm-dd or dd/mm/yyyy.
- Color coding conventions for financial models: blue for inputs, black for formulas, green for cross-sheet links, red for external links, yellow background for key assumptions.
- Formula construction rules: pull every assumption into its own cell with absolute references like $B$6, keep formulas consistent across periods, document hardcoded values with a source citation comment like "Source: PVI BCTC Q1/2026, p.45".
- Serial numbers, IMEI, and phone numbers are now forced to text format so Excel does not silently convert them to scientific notation and drop digits.

AI edit faster and more polished
- The Claude subprocess that powers AI edit now pre-warms the moment you open any HTML or SVG file, not only when you toggle AI mode. The cold spawn (~5 to 9 seconds) is paid during file load, so even the first edit returns quickly.
- The system prompt is now bound to the Anthropic prompt cache. Time to first token drops by roughly 100 to 200 ms per edit and token usage is lower.
- While AI is editing, the selected region gets a translucent blurred overlay with a conic gradient revolving around its perimeter, so it is obvious which area is being processed.
- An elapsed-seconds counter appears under the Editing button so long edits do not feel stuck.

Dark splash screen on launch
- The launcher splash (the small window with the penguin while the server boots) is now dark to match the login page instead of near-white.
- Background switches from white gradient to a warm dark gradient (#2F2F2D to #1F1F1D).
- The drop shadow becomes a soft sky-blue glow for depth on dark backgrounds.
- The penguin ground shadow becomes a sky-tinted halo so it stays visible.
- Progress bar grows from 3 px to 5 px with a brighter sky-400 fill so progress is easier to see.
- Close button switches from slate to white at 60% opacity.

These changes do not touch existing user data, chats, login, or files.


v2.2.1

Fix: changing an agent's model in Edit Agent did not take effect
- Symptom: editing an agent in the Edit Agent dialog, switching the model (e.g. Sonnet 4.6 to Opus 4.8), and saving updated the value on disk but chat replies still used the old model.
- Cause: the Claude CLI session that backs each agent is pinned to whichever model started it, and Penguin keeps two caches that resume into it: employees.sessionId (live warm pool) and the task_sessions table (per task resume id). The PATCH employees endpoint only invalidated those caches when name, role, system prompt, or skills changed.
- Fix: model changes are now treated as a session-busting edit too. employees.sessionId is nulled and every task_sessions row for that employee is wiped, so the next turn spawns a fresh CLI subprocess on the chosen model.

Brighter dark theme to match claude.ai
- The main chat surface lightens from #1F1E1B to #262624. Elevated panels, cards, hover states, and borders cascade up too so depth still reads.
- The sidebar stays at #1A1916 to mirror claude.ai's deeper sidebar / lighter chat contrast.
- Dark theme body text bumps to #F5F4ED. Tailwind's slate-100..600 utilities get warm-tone overrides in dark mode so they sit cleanly on top of the warmer bg instead of fading into it.
- Light theme body text also deepens to #2E2D2A with a matched warm slate ladder for crisper contrast on the cream bg.


v2.2.0

App renamed to Penguin with a new icon
- The app is renamed from Agent P to Penguin. New icon: penguin avatar on a blue rounded background, with a chat bubble.
- The icon shows on the taskbar, Desktop and Start Menu shortcuts, the Edge tab, splash screen, and login.
- Old "Agent P" shortcuts on Desktop and Start Menu are removed automatically. The pinned taskbar shortcut is kept in place; its icon and Windows AUMID are refreshed without re-pinning.
- The local data folder %LOCALAPPDATA%\AgentP\ keeps its name. No migration runs, and the saved login still works.

New model option: Opus 4.8
- Each employee's model dropdown in Settings now lists Opus 4.8 at the top of the Claude group, alongside Opus 4.7, Sonnet 4.6, and Haiku 4.5.
- Claude Max accounts can use it right away, no extra configuration.

Fix: in-app updater silently did nothing after Restart
- Symptom: clicking Restart in Settings then Update appeared to work (the page reloaded), but after closing and reopening the app the version was still the previous one and Settings still said "new version available".
- Cause: the apply step spawned the PowerShell swap script with Node's detached:true + unref() pattern, which is not reliable on Windows. The child PowerShell got cleaned up together with the Node parent before it could even start, so the staged files in .update-staging\extracted\ never got copied over the install.
- Fix: the apply step now launches the swap script through cmd /c start /B, which moves the launched PowerShell into its own process tree so the parent Node can safely exit while the swap continues. Exit delay also raised from 500ms to 1500ms as a small extra margin.
- Takes effect for updates from v2.2 onward.

Fix: version stayed stuck on the previous number after an update
- Symptom: after installing an update, closing and reopening the app, Settings then Update kept saying "new version available", because the displayed current version did not change.
- Cause: the compiled .next/ bundle from the previous version baked the old version number at build time, and a partial file swap could leave old chunks mixed with new ones.
- Fix: the in-app updater now wipes the old .next/ folder before applying the staged files, so only the fresh bundle serves requests after restart. The /api/update/check route also reads package.json from disk at runtime instead of importing it as a baked constant, so a partial swap can no longer cause a wrong version to be reported.
- Takes effect for updates from v2.2 onward.
