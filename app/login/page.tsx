"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  // The login screen is always dark (it's designed dark-only; the light-theme
  // overrides would break it). Force dark on mount — covers client-side nav to
  // /login — and restore the user's saved theme on leave so the main app still
  // respects light mode after a successful login (router.push is a SPA nav).
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, isSetup: needsSetup }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error); return; }
    router.push("/");
  }

  if (needsSetup === null) return <div className="min-h-screen bg-[#262624]" />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#262624] p-4">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes penguinFloat {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-6px); }
        }
        @keyframes penguinGlow {
          0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(1); }
          50%      { opacity: 0.85; transform: translateX(-50%) scale(1.08); }
        }
        .penguin-float { animation: penguinFloat 3.6s ease-in-out infinite; }
        .penguin-glow  { animation: penguinGlow  3.6s ease-in-out infinite; }
      `}} />

      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[420px] w-[420px] rounded-full bg-sky-500/[0.04] blur-[100px]" />
        <div className="absolute left-1/3 top-2/3 h-[300px] w-[300px] rounded-full bg-violet-500/[0.03] blur-[80px]" />
      </div>

      <form
        onSubmit={submit}
        className={`relative w-full max-w-sm space-y-6 transition-all duration-700 ease-out ${ready ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
      >
        <div className="text-center">
          <div className="relative mx-auto mb-6 flex h-28 w-28 items-center justify-center">
            {/* Soft halo behind the penguin — pulses gently in time with the float. */}
            <span
              className="penguin-glow pointer-events-none absolute left-1/2 top-1/2 -translate-y-1/2 h-24 w-24 rounded-[28%] bg-sky-400/30 blur-2xl"
              aria-hidden
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/icon-512.png"
              alt="Penguin"
              draggable={false}
              className="penguin-float relative h-24 w-24 select-none drop-shadow-[0_8px_24px_rgba(14,165,233,0.35)]"
            />
          </div>
          <h1
            className="text-[56px] leading-none"
            style={{ fontFamily: '"Changa One", "Segoe UI", sans-serif', filter: "drop-shadow(0 0 14px rgba(0,0,0,0.4))" }}
            aria-label="PENGUIN"
          >
            {"PENGUIN".split("").map((ch, i) =>
              ch === " " ? (
                <span key={i} className="inline-block w-3" />
              ) : (
                <span
                  key={i}
                  className="inline-block cursor-default bg-gradient-to-b from-white to-sky-300 bg-clip-text text-transparent transition-[transform,filter,color] duration-300 ease-out will-change-transform hover:-translate-y-1.5 hover:scale-110 hover:[filter:drop-shadow(0_0_18px_rgba(125,211,252,0.65))]"
                  style={{ transitionDelay: `${i * 10}ms` }}
                >
                  {ch}
                </span>
              )
            )}
          </h1>
          <p className="mt-4 text-sm text-slate-500">
            {needsSetup ? "Set a password to protect your workspace" : "Enter your password"}
          </p>
        </div>

        {/* Input */}
        <div>
          <input
            type="password"
            autoFocus
            placeholder={needsSetup ? "Choose a password" : "Password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all duration-200 ease-out focus:border-sky-400/40 focus:bg-white/[0.05] focus:ring-1 focus:ring-sky-400/20 focus:shadow-lg focus:shadow-sky-500/[0.06]"
          />
          <div className={`overflow-hidden transition-all duration-300 ease-out ${error ? "max-h-8 mt-2 opacity-100" : "max-h-0 opacity-0"}`}>
            <p className="text-xs text-red-400">{error}</p>
          </div>
        </div>

        {/* Button */}
        <button
          type="submit"
          disabled={loading || password.length < 4}
          className="group relative w-full overflow-hidden rounded-xl bg-sky-500 py-3 text-sm font-medium text-white transition-all duration-200 ease-out hover:bg-sky-400 hover:shadow-lg hover:shadow-sky-500/20 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:active:scale-100"
        >
          <span className={`inline-flex items-center gap-2 transition-all duration-200 ${loading ? "opacity-0" : "opacity-100"}`}>
            {needsSetup ? "Set password & enter" : "Unlock"}
            <svg className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
          </span>
          {loading && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            </span>
          )}
        </button>

        {needsSetup && (
          <p className="text-center text-[11px] text-slate-600 transition-opacity duration-500">
            Minimum 4 characters. Stored locally on this machine.
          </p>
        )}
      </form>

    </div>
  );
}
