"use client";
import { useEffect, useState, ReactNode } from "react";
import {
  X, Check, ExternalLink, KeyRound,
  Sliders, User, ScrollText, KeySquare,
  Zap, Scale, BookOpen, Download, Loader2, RotateCw,
} from "lucide-react";
import { useOffice } from "@/store/office-store";
import { ThemeToggle } from "@/components/theme-toggle";
import { LordIcon } from "@/components/lord-icon";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = "general" | "profile" | "rules" | "api" | "update";

const TABS: { id: Tab; label: string; icon: typeof User }[] = [
  { id: "general", label: "General", icon: Sliders },
  { id: "profile", label: "Profile", icon: User },
  { id: "rules",   label: "Rules",   icon: ScrollText },
  { id: "api",     label: "API",     icon: KeySquare },
  { id: "update",  label: "Update",  icon: Download },
];

export function SettingsDialog({ open, onClose }: Props) {
  const profile = useOffice(s => s.profile);
  const setProfile = useOffice(s => s.setProfile);

  const [tab, setTab] = useState<Tab>("general");

  const [name, setName] = useState(profile.name);
  const [address, setAddress] = useState(profile.address);
  const [responseStyle, setResponseStyle] = useState("balanced");
  const [saving, setSaving] = useState(false);

  const [hasOpenrouterKey, setHasOpenrouterKey] = useState(false);
  const [openrouterKey, setOpenrouterKey] = useState("");

  const [fileExportRule, setFileExportRule] = useState("");
  const [defaultFileExportRule, setDefaultFileExportRule] = useState("");

  const [fileRoutingRule, setFileRoutingRule] = useState("");
  const [defaultFileRoutingRule, setDefaultFileRoutingRule] = useState("");

  useEffect(() => {
    if (!open) return;
    // If an update is mid-flight, jump straight back to its tab so the user
    // sees progress instead of landing on General. Read the phase via
    // getState() instead of subscribing — subscribing would re-run this
    // effect every time the phase changed (e.g. UpdatePanel's doCheck flips
    // to "checking"), which would reset the tab and unmount UpdatePanel
    // mid-render.
    const kind = useOffice.getState().updatePhase.kind;
    const inFlight = kind === "downloading"
      || kind === "staging"
      || kind === "ready"
      || kind === "restarting";
    setTab(inFlight ? "update" : "general");
    setName(profile.name);
    setAddress(profile.address);
    setOpenrouterKey("");
    fetch("/api/settings")
      .then(r => r.json())
      .then((d: {
        hasOpenrouterKey?: boolean;
        responseStyle?: string;
        fileExportRule?: string;
        defaultFileExportRule?: string;
        fileRoutingRule?: string;
        defaultFileRoutingRule?: string;
      }) => {
        setHasOpenrouterKey(!!d.hasOpenrouterKey);
        if (d.responseStyle) setResponseStyle(d.responseStyle);
        setFileExportRule(d.fileExportRule || "");
        setDefaultFileExportRule(d.defaultFileExportRule || "");
        setFileRoutingRule(d.fileRoutingRule || "");
        setDefaultFileRoutingRule(d.defaultFileRoutingRule || "");
      })
      .catch(() => { /* keep defaults */ });
  }, [open, profile]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, string> = {
        name: name.trim() || "anh",
        address: address.trim() || "anh",
        responseStyle,
        fileExportRule,
        fileRoutingRule,
      };
      if (openrouterKey.trim()) body.openrouterApiKey = openrouterKey.trim();

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const p = await res.json();
      setProfile({ name: p.name, address: p.address });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterApiKey: "" }),
    });
    setHasOpenrouterKey(false);
    setOpenrouterKey("");
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-[#2F2D29] shadow-2xl ring-1 ring-black/40 animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-7 py-4">
          <h2 className="text-[17px] font-semibold tracking-tight text-slate-100">Settings</h2>
          <button
            onClick={onClose}
            className="group rounded-lg p-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
            aria-label="Close"
          >
            <LordIcon src="https://cdn.lordicon.com/vfiwitrm.json" size={26} trigger="hover" />
          </button>
        </div>

        {/* Body: sidebar + content. overflow-hidden so the content cell's
            overflow-y-auto actually clips and scrolls — without it, long
            children (Update tab) overflow the dialog instead of scrolling. */}
        <div className="grid grid-cols-[180px_1fr] min-h-[460px] max-h-[68vh] overflow-hidden">
          {/* Sidebar */}
          <nav className="border-r border-white/[0.06] p-3">
            <ul className="space-y-0.5">
              {TABS.map(t => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => setTab(t.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                        active
                          ? "bg-white/[0.06] text-slate-100"
                          : "text-slate-400 hover:bg-white/[0.03] hover:text-slate-200"
                      }`}
                    >
                      <Icon size={15} className={active ? "text-amber-300" : "text-slate-500"} />
                      <span>{t.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Content */}
          <div className="overflow-y-auto px-7 py-6">
            {tab === "general" && (
              <div className="space-y-6">
                <Section title="Appearance" hint="Choose light or dark mode for the whole app.">
                  <ThemeToggle />
                </Section>

                <Section title="Response style" hint="How detailed each agent reply should be.">
                  <div className="grid grid-cols-3 gap-2.5">
                    {([
                      { value: "concise",  label: "Concise",  desc: "1-2 sentences",          icon: Zap },
                      { value: "balanced", label: "Balanced", desc: "2-3 sentences (default)", icon: Scale },
                      { value: "detailed", label: "Detailed", desc: "Full when needed",        icon: BookOpen },
                    ] as const).map(opt => {
                      const Icon = opt.icon;
                      const active = responseStyle === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setResponseStyle(opt.value)}
                          className={`group flex flex-col items-center gap-2 rounded-xl border px-4 py-5 text-center transition ${
                            active
                              ? "border-amber-400/60 bg-amber-400/[0.07] text-slate-100"
                              : "border-white/[0.08] bg-white/[0.015] text-slate-400 hover:border-white/20 hover:bg-white/[0.03] hover:text-slate-200"
                          }`}
                        >
                          <Icon size={20} className={active ? "text-amber-300" : "text-slate-500 group-hover:text-slate-300"} />
                          <div className="text-[13px] font-medium">{opt.label}</div>
                          <div className="text-[11px] text-slate-500">{opt.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </Section>
              </div>
            )}

            {tab === "profile" && (
              <div className="space-y-6">
                <Section title="Name" hint="Agents will remember and address you by this name.">
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Nam"
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none transition focus:border-amber-400/60"
                  />
                </Section>

                <Section title="Address" hint={`Agents will refer to you as "${address || "anh"}" and use @${address || "anh"} when they need a reply.`}>
                  <input
                    value={address}
                    onChange={e => setAddress(e.target.value)}
                    placeholder="e.g. anh, sếp, Nam"
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none transition focus:border-amber-400/60"
                  />
                </Section>
              </div>
            )}

            {tab === "rules" && (
              <div className="space-y-6">
                <RuleBlock
                  title="File export rule"
                  hint="When agents may export a file (PDF/Excel/dashboard) instead of replying inline. Leave blank to use the default."
                  value={fileExportRule}
                  defaultValue={defaultFileExportRule}
                  onChange={setFileExportRule}
                />
                <RuleBlock
                  title="File routing rule"
                  hint="Who may create files (default: only Aria; other agents must @Aria with the content). Leave blank to use the default."
                  value={fileRoutingRule}
                  defaultValue={defaultFileRoutingRule}
                  onChange={setFileRoutingRule}
                />
              </div>
            )}

            {tab === "api" && (
              <div className="space-y-6">
                <Section
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      <KeyRound size={13} className="text-teal-300" />
                      OpenRouter API key
                    </span>
                  }
                  hint="Paste a key so agents can use non-Claude models (GPT, Gemini, DeepSeek, Llama, ...). Stored locally. Leave blank to keep the existing key."
                >
                  <KeyField
                    label="OpenRouter"
                    configured={hasOpenrouterKey}
                    value={openrouterKey}
                    onChange={setOpenrouterKey}
                    onClear={clearKey}
                    placeholder="sk-or-v1-..."
                    link="https://openrouter.ai/keys"
                  />
                </Section>

                <div className="rounded-lg border border-white/[0.07] bg-white/[0.015] px-4 py-3 text-[11.5px] italic leading-relaxed text-slate-500">
                  Agents on OpenRouter models can export files (PDF, Word, Excel, dashboard) but can&apos;t run Bash/Python like Claude-based agents.
                </div>
              </div>
            )}

            {tab === "update" && <UpdatePanel />}
          </div>
        </div>

        {/* Footer — hidden on the Update tab, which has its own Save /
            Download & install / Restart actions inline. */}
        {tab !== "update" && (
          <div className="flex justify-end gap-2 border-t border-white/[0.06] px-7 py-3.5">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-[13px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-amber-400 px-5 py-2 text-[13px] font-medium text-slate-900 transition hover:bg-amber-300 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title, hint, children,
}: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[13px] font-medium text-slate-200">{title}</div>
      {hint && <div className="mb-3 text-[11.5px] leading-relaxed text-slate-500">{hint}</div>}
      {children}
    </div>
  );
}

function RuleBlock({
  title, hint, value, defaultValue, onChange,
}: {
  title: string;
  hint: string;
  value: string;
  defaultValue: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-medium text-slate-200">{title}</div>
        {value.trim() === "" ? (
          <button
            type="button"
            onClick={() => onChange(defaultValue)}
            className="text-[11px] text-amber-300/80 transition hover:text-amber-200"
          >
            Open default to edit
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-[11px] text-slate-400 transition hover:text-slate-200"
          >
            Reset to default
          </button>
        )}
      </div>
      <div className="mb-2.5 text-[11.5px] leading-relaxed text-slate-500">{hint}</div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={defaultValue ? "Using the default. Click 'Open default to edit' to view and modify." : "Loading default..."}
        rows={8}
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 font-mono text-[11.5px] leading-snug outline-none transition focus:border-amber-400/60"
      />
    </div>
  );
}

type CheckResult = {
  configured: boolean;
  currentVersion: string;
  latestVersion?: string;
  available?: boolean;
  notes?: string;
  releaseUrl?: string;
  assetUrl?: string;
  assetSize?: number;
  assetName?: string;
  error?: string;
};

function UpdatePanel() {
  // Lifted to the global store so the update flow survives closing the
  // Settings dialog or switching to another Settings tab — the panel can
  // remount and pick the live phase back up.
  const phase = useOffice(s => s.updatePhase);
  const setPhase = useOffice(s => s.setUpdatePhase);
  const [stagingElapsed, setStagingElapsed] = useState(0);
  const [restartElapsed, setRestartElapsed] = useState(0);
  const [downloadElapsed, setDownloadElapsed] = useState(0);
  // Live byte counter from the server-side download stream. Polled while the
  // phase is "downloading"; lets us show a real progress bar instead of a
  // bare spinner.
  const [downloadBytes, setDownloadBytes] = useState<{ downloaded: number; total: number } | null>(null);

  // GitHub auto-update config (saved in settings).
  const [repo, setRepo] = useState("");
  const [savedRepo, setSavedRepo] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: { updateRepo?: string; hasUpdateGithubToken?: boolean }) => {
        setRepo(d.updateRepo || "");
        setSavedRepo(d.updateRepo || "");
        setHasToken(!!d.hasUpdateGithubToken);
      })
      .catch(() => { /* keep blanks */ });
    // Auto-check on mount if a repo is configured.
    doCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase.kind !== "staging") return;
    const t = setInterval(() => setStagingElapsed(Math.floor((Date.now() - phase.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase.kind !== "restarting") return;
    const t = setInterval(() => setRestartElapsed(Math.floor((Date.now() - phase.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase.kind !== "downloading") return;
    const t = setInterval(() => setDownloadElapsed(Math.floor((Date.now() - phase.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  // Poll the server for byte-level download progress while we're in the
  // downloading phase. The endpoint reads the live counter inside the
  // download route's stream pipeline.
  useEffect(() => {
    if (phase.kind !== "downloading") { setDownloadBytes(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/update/progress", { cache: "no-store" });
        const d = await r.json() as { active?: boolean; downloaded?: number; total?: number };
        if (!cancelled && d.active && typeof d.downloaded === "number" && typeof d.total === "number") {
          setDownloadBytes({ downloaded: d.downloaded, total: d.total });
        }
      } catch { /* network blip — keep last known value */ }
    };
    tick();
    const t = setInterval(tick, 500);
    return () => { cancelled = true; clearInterval(t); };
  }, [phase]);

  async function saveConfig() {
    setConfigSaving(true);
    try {
      const body: Record<string, string> = { updateRepo: repo.trim() };
      if (token.trim()) body.updateGithubToken = token.trim();
      const r = await fetch("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setSavedRepo(d.updateRepo || "");
      setHasToken(!!d.hasUpdateGithubToken);
      setToken("");
      await doCheck();
    } finally {
      setConfigSaving(false);
    }
  }

  async function clearToken() {
    await fetch("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updateGithubToken: "" }),
    });
    setHasToken(false);
    setToken("");
  }

  async function doCheck() {
    setPhase({ kind: "checking" });
    try {
      const r = await fetch("/api/update/check", { cache: "no-store" });
      const d = await r.json() as CheckResult;
      setCheck(d);
    } catch (e) {
      setCheck({ configured: false, currentVersion: "?", error: (e as Error).message });
    }
    setPhase({ kind: "idle" });
  }

  async function runStage() {
    setStagingElapsed(0);
    setPhase({ kind: "staging", startedAt: Date.now() });
    try {
      const r = await fetch("/api/update/stage", { method: "POST" });
      const d = await r.json() as { ok?: boolean; version?: string; error?: string };
      if (!d.ok) { setPhase({ kind: "error", message: d.error || "Staging failed." }); return; }
      setPhase({ kind: "ready", version: d.version });
    } catch (e) {
      setPhase({ kind: "error", message: `Staging failed: ${(e as Error).message}` });
    }
  }

  async function downloadAndInstall() {
    if (!check?.assetUrl) return;
    setDownloadElapsed(0);
    setPhase({ kind: "downloading", startedAt: Date.now(), size: check.assetSize });
    try {
      const r = await fetch("/api/update/download", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: check.assetUrl }),
      });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (!d.ok) { setPhase({ kind: "error", message: d.error || "Download failed." }); return; }
    } catch (e) {
      setPhase({ kind: "error", message: `Download failed: ${(e as Error).message}` });
      return;
    }
    await runStage();
  }

  async function restart() {
    setPhase({ kind: "restarting", startedAt: Date.now() });
    try { await fetch("/api/update/apply", { method: "POST" }); }
    catch { /* server exits before responding — expected */ }
    // Don't try to auto-reload. `next start` boot time varies widely (5s on a
    // fast box, 60s+ on a slow one); reloading too early lands on the
    // browser's "can't reach this page". Show a manual close+reopen
    // instruction instead — the swap script keeps running in the background
    // and the user picks up the new version on the next launch.
  }

  // Active-phase screens (take over the panel).
  if (phase.kind === "downloading") {
    const total = downloadBytes?.total || phase.size || 0;
    const downloaded = downloadBytes?.downloaded || 0;
    const pct = total > 0 ? Math.min(1, downloaded / total) : 0;
    const totalMb = total > 0 ? (total / (1024 * 1024)).toFixed(1) : "?";
    const downloadedMb = (downloaded / (1024 * 1024)).toFixed(1);
    return (
      <div className="space-y-4">
        <PhaseHeader title="Downloading from GitHub" />
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <div className="flex items-center justify-between text-[12.5px] text-slate-300">
            <span>{downloadedMb} / {totalMb} MB</span>
            <span className="text-slate-500">{total > 0 ? `${Math.round(pct * 100)}%` : "starting..."}</span>
          </div>
          <div className="mt-2.5">
            <ProgressBar pct={pct} label={`Elapsed ${downloadElapsed}s`} />
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "staging") {
    return (
      <div className="space-y-4">
        <PhaseHeader title="Extracting and installing dependencies" />
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 text-center">
          <Loader2 size={28} className="mx-auto animate-spin text-amber-300" />
          <div className="mt-3 text-[12.5px] text-slate-300">Running <code className="text-amber-200">npm install</code> in staging</div>
          <div className="mt-1 text-[11px] text-slate-500">Elapsed {stagingElapsed}s — typically takes 30 to 90 seconds.</div>
        </div>
      </div>
    );
  }

  if (phase.kind === "ready") {
    return (
      <div className="space-y-4">
        <PhaseHeader title="Update ready to install" />
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] p-5">
          <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-200">
            <Check size={15} />
            {phase.version ? `Version ${phase.version} staged` : "Update staged"}
          </div>
          <div className="mt-1.5 text-[11.5px] text-emerald-200/70">
            Click below to restart Penguin with the new version. The page will refresh automatically once the new server is up.
          </div>
        </div>
        <button
          type="button"
          onClick={restart}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-3 text-[13px] font-semibold text-slate-900 transition hover:bg-emerald-400"
        >
          <RotateCw size={15} />
          Restart Penguin
        </button>
        <button
          type="button"
          onClick={() => setPhase({ kind: "idle" })}
          className="w-full text-center text-[11px] text-slate-500 transition hover:text-slate-300"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (phase.kind === "restarting") {
    return (
      <div className="space-y-4">
        <PhaseHeader title="Update installed — please reopen Penguin" />
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] p-6 text-center">
          <Check size={32} className="mx-auto text-emerald-300" />
          <div className="mt-4 text-[13px] font-medium text-emerald-100">
            The new version is staged and ready.
          </div>
          <div className="mt-2 text-[12px] leading-relaxed text-emerald-100/80">
            Close this Penguin window and open Penguin again from your shortcut
            (Desktop / Start Menu / taskbar) to start the new version.
          </div>
        </div>
      </div>
    );
  }

  // idle / checking / error — show config + status
  const checking = phase.kind === "checking";
  return (
    <div className="space-y-6">
      {phase.kind === "error" && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3 text-[12px] text-rose-200">
          {phase.message}
        </div>
      )}

      <Section
        title="Update source"
        hint="Penguin pulls updates from a GitHub releases repo. The default below is preset — only change it if your distributor publishes from somewhere else."
      >
        <div className="space-y-2">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repo  (e.g. namdo/agent-p-releases)"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none transition focus:border-amber-400/60"
          />
          <div className="flex gap-1.5">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={hasToken ? "•••••••••• (PAT saved — enter a new one to replace)" : "GitHub PAT (only needed for private repos)"}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none transition focus:border-amber-400/60"
            />
            {hasToken && (
              <button
                type="button"
                onClick={clearToken}
                className="shrink-0 rounded-lg border border-white/10 px-3 text-[11px] text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300"
                title="Clear saved PAT"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex items-center justify-between pt-1">
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=Agent%20P%20updater"
              target="_blank" rel="noreferrer"
              className="flex items-center gap-0.5 text-[10.5px] text-slate-500 transition hover:text-slate-300"
            >
              create a PAT <ExternalLink size={9} />
            </a>
            <button
              type="button"
              onClick={saveConfig}
              disabled={configSaving || repo.trim() === savedRepo && !token.trim()}
              className="rounded-lg bg-amber-400 px-4 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-amber-300 disabled:opacity-50"
            >
              {configSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </Section>

      <Section title="Status">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11.5px] text-slate-500">Installed</div>
              <div className="text-[13px] font-medium text-slate-200">v{check?.currentVersion || "..."}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[11.5px] text-slate-500">Latest on GitHub</div>
              <div className="text-[13px] font-medium text-slate-200">
                {checking ? "checking..." : check?.latestVersion ? `v${check.latestVersion}` : "—"}
              </div>
            </div>
            <button
              type="button"
              onClick={doCheck}
              disabled={checking || !savedRepo}
              className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11.5px] text-slate-300 transition hover:border-white/25 hover:bg-white/[0.04] disabled:opacity-40"
            >
              {checking ? <Loader2 size={12} className="animate-spin" /> : "Check now"}
            </button>
          </div>

          {check?.error && (
            <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 text-[11.5px] text-rose-200">
              {check.error}
            </div>
          )}

          {check?.available && check.assetUrl && (
            <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] p-3">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-emerald-200">
                <Download size={13} />
                Version {check.latestVersion} available
              </div>
              {check.notes && (
                <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-emerald-100/70">
                  {check.notes}
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={downloadAndInstall}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-[12px] font-semibold text-slate-900 transition hover:bg-emerald-400"
                >
                  <Download size={12} />
                  Download &amp; install
                </button>
                {check.releaseUrl && (
                  <a
                    href={check.releaseUrl} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-[11px] text-emerald-200/70 transition hover:text-emerald-100"
                  >
                    View release <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          )}

          {check && check.configured && !check.available && !check.error && check.latestVersion && (
            <div className="mt-3 text-[11.5px] text-slate-400">
              You&apos;re running the latest version.
            </div>
          )}

          {check && !check.configured && (
            <div className="mt-3 text-[11.5px] text-slate-500">
              Save a repo above to enable update checks.
            </div>
          )}
        </div>
      </Section>

    </div>
  );
}

function PhaseHeader({ title }: { title: string }) {
  return <div className="text-[13px] font-medium text-slate-200">{title}</div>;
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-amber-400 transition-all"
          style={{ width: `${Math.max(2, pct * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 text-right text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function KeyField({
  label, configured, value, onChange, onClear, placeholder, link,
}: {
  label: string;
  configured: boolean;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
  link: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-slate-300">
          {label}
          {configured && (
            <span className="flex items-center gap-0.5 rounded-full bg-teal-400/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-teal-300">
              <Check size={9} /> saved
            </span>
          )}
        </div>
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-0.5 text-[10.5px] text-slate-500 transition hover:text-slate-300"
        >
          get key <ExternalLink size={9} />
        </a>
      </div>
      <div className="flex gap-1.5">
        <input
          type="password"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={configured ? "•••••••••••••• (enter a new key to replace)" : placeholder}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none transition focus:border-teal-400/60"
        />
        {configured && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-lg border border-white/10 px-3 text-[11px] text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300"
            title={`Clear ${label} key`}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
