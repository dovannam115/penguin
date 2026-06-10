"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  // When accounts already exist, the user can flip between logging in and
  // creating an additional account.
  const [createMode, setCreateMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  // The login screen is always dark (it's designed dark-only; the light-theme
  // overrides would break it). Force dark on mount, restore saved theme on leave.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light");
    root.classList.add("dark");
    return () => {
      let saved: string | null = null;
      try { saved = localStorage.getItem("agentp.theme"); } catch { /* ignore */ }
      root.classList.remove("dark", "light");
      root.classList.add(saved === "light" ? "light" : "dark");
    };
  }, []);

  useEffect(() => {
    fetch("/api/auth").then(r => r.json()).then(d => {
      setNeedsSetup(d.needsSetup);
      requestAnimationFrame(() => setReady(true));
    });
  }, []);

  // First-ever account, or the user toggled "create account".
  const isSignup = needsSetup === true || createMode;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password, mode: isSignup ? "signup" : "login" }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error); return; }
    router.push("/");
  }

  if (needsSetup === null) return <div className="min-h-screen bg-[#262624]" />;

  const subtitle = needsSetup
    ? "Create the first account for this workspace"
    : isSignup ? "Create a new account" : "Sign in to your account";
  const cta = needsSetup ? "Create account & enter" : isSignup ? "Create account" : "Sign in";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#262624] p-4">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes penguinFloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        @keyframes penguinGlow { 0%,100%{opacity:.55;transform:translateX(-50%) scale(1)} 50%{opacity:.85;transform:translateX(-50%) scale(1.08)} }
        .penguin-float { animation: penguinFloat 3.6s ease-in-out infinite; }
        .penguin-glow  { animation: penguinGlow  3.6s ease-in-out infinite; }
      `}} />

      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[420px] w-[420px] rounded-full bg-sky-500/[0.04] blur-[100px]" />
        <div className="absolute left-1/3 top-2/3 h-[300px] w-[300px] rounded-full bg-violet-500/[0.03] blur-[80px]" />
      </div>

      <form
        onSubmit={submit}
        className={`relative w-full max-w-sm space-y-5 transition-all duration-700 ease-out ${ready ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
      >
        <div className="text-center">
          <div className="relative mx-auto mb-6 flex h-28 w-28 items-center justify-center">
            <span className="penguin-glow pointer-events-none absolute left-1/2 top-1/2 -translate-y-1/2 h-24 w-24 rounded-[28%] bg-sky-400/30 blur-2xl" aria-hidden />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon-512.png" alt="Penguin" draggable={false} className="penguin-float relative h-24 w-24 select-none drop-shadow-[0_8px_24px_rgba(14,165,233,0.35)]" />
          </div>
          <h1
            className="text-[56px] leading-none"
            style={{ fontFamily: '"Changa One", "Segoe UI", sans-serif', filter: "drop-shadow(0 0 14px rgba(0,0,0,0.4))" }}
            aria-label="PENGUIN"
          >
            {"PENGUIN".split("").map((ch, i) => (
              <span
                key={i}
                className="inline-block cursor-default bg-gradient-to-b from-white to-sky-300 bg-clip-text text-transparent transition-[transform,filter,color] duration-300 ease-out will-change-transform hover:-translate-y-1.5 hover:scale-110 hover:[filter:drop-shadow(0_0_18px_rgba(125,211,252,0.65))]"
                style={{ transitionDelay: `${i * 10}ms` }}
              >
                {ch}
              </span>
            ))}
          </h1>
          <p className="mt-4 text-sm text-slate-500">{subtitle}</p>
        </div>

        <div className="space-y-3">
          <input
            type="text"
            autoFocus
            placeholder="Username"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all duration-200 ease-out focus:border-sky-400/40 focus:bg-white/[0.05] focus:ring-1 focus:ring-sky-400/20"
          />
          <input
            type="password"
            placeholder={isSignup ? "Choose a password" : "Password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all duration-200 ease-out focus:border-sky-400/40 focus:bg-white/[0.05] focus:ring-1 focus:ring-sky-400/20"
          />
          <div className={`overflow-hidden transition-all duration-300 ease-out ${error ? "max-h-8 opacity-100" : "max-h-0 opacity-0"}`}>
            <p className="text-xs text-red-400">{error}</p>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !name.trim() || password.length < 4}
          className="group relative w-full overflow-hidden rounded-xl bg-sky-500 py-3 text-sm font-medium text-white transition-all duration-200 ease-out hover:bg-sky-400 hover:shadow-lg hover:shadow-sky-500/20 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className={`inline-flex items-center gap-2 transition-all duration-200 ${loading ? "opacity-0" : "opacity-100"}`}>
            {cta}
            <svg className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
          </span>
          {loading && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            </span>
          )}
        </button>

        {/* Toggle login <-> create account (only once at least one account exists) */}
        {needsSetup === false && (
          <p className="text-center text-[12px] text-slate-500">
            {isSignup ? "Already have an account? " : "No account yet? "}
            <button
              type="button"
              onClick={() => { setCreateMode(m => !m); setError(""); }}
              className="text-sky-400 hover:text-sky-300 transition"
            >
              {isSignup ? "Sign in" : "Create new account"}
            </button>
          </p>
        )}
        {isSignup && (
          <p className="text-center text-[11px] text-slate-600">Minimum 4 characters. Stored locally on this machine.</p>
        )}
      </form>
    </div>
  );
}
