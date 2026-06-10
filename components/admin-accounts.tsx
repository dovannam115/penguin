"use client";

import { useEffect, useState } from "react";
import { X, ShieldCheck, Check, Clock, Eye } from "lucide-react";

interface Account {
  id: string;
  name: string;
  approved: boolean;
  isAdmin: boolean;
  createdAt: number;
}

/** Admin-only panel to approve / revoke accounts that have signed up. */
export function AdminAccounts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    fetch("/api/admin/accounts", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { setAccounts(d.accounts ?? []); })
      .catch(() => setError("Couldn't load accounts"))
      .finally(() => setLoading(false));
  }, [open]);

  // Enter view-as for an account, then reload into its (read-only) workspace.
  async function view(id: string) {
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/view-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: id }),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Couldn't view"); setBusyId(null); return; }
      window.location.reload();
    } catch { setError("Network error"); setBusyId(null); }
  }

  async function act(id: string, action: "approve" | "revoke") {
    setBusyId(id);
    setError("");
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || "Action failed"); return; }
      setAccounts(d.accounts ?? []);
    } catch {
      setError("Network error");
    } finally {
      setBusyId(null);
    }
  }

  if (!open) return null;

  const pending = accounts.filter(a => !a.approved);
  const active = accounts.filter(a => a.approved);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#171613] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-300" aria-label="Close">
          <X size={16} />
        </button>

        <div className="mb-1 flex items-center gap-2 text-sky-300">
          <ShieldCheck size={18} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">Manage access</span>
        </div>
        <h2 className="text-xl font-semibold text-slate-100">Accounts</h2>
        <p className="mt-1.5 text-[13px] text-slate-400">Approve people who signed up before they can use Penguin.</p>

        {loading && <div className="py-6 text-center text-[13px] text-slate-500">Loading…</div>}
        {error && <p className="mt-3 text-[12px] text-red-400">{error}</p>}

        {!loading && (
          <div className="mt-5 max-h-[55vh] space-y-5 overflow-y-auto pr-1">
            {/* Pending */}
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-amber-400/90">
                <Clock size={12} /> Pending ({pending.length})
              </div>
              {pending.length === 0 && <p className="px-1 text-[13px] text-slate-600">No one waiting.</p>}
              {pending.map(a => (
                <div key={a.id} className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-3.5 py-2.5">
                  <span className="truncate text-[14px] text-slate-200">{a.name}</span>
                  <button
                    onClick={() => act(a.id, "approve")}
                    disabled={busyId === a.id}
                    className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-emerald-400 active:scale-95 disabled:opacity-40"
                  >
                    <Check size={13} /> Approve
                  </button>
                </div>
              ))}
            </div>

            {/* Active */}
            <div>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">Active ({active.length})</div>
              {active.map(a => (
                <div key={a.id} className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5">
                  <span className="truncate text-[14px] text-slate-200">{a.name}</span>
                  {a.isAdmin && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">admin</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      onClick={() => view(a.id)}
                      disabled={busyId === a.id}
                      className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/[0.06] disabled:opacity-40"
                      title="View this account's workspace (read-only)"
                    >
                      <Eye size={12} /> View
                    </button>
                    {!a.isAdmin && (
                      <button
                        onClick={() => act(a.id, "revoke")}
                        disabled={busyId === a.id}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-40"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
