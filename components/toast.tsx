"use client";

import { create } from "zustand";
import { useEffect } from "react";
import { X, AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

type ToastType = "info" | "success" | "warning" | "error";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ConfirmState {
  message: string;
  resolve: (ok: boolean) => void;
}

interface ToastStore {
  toasts: Toast[];
  confirm: ConfirmState | null;
  push: (message: string, type?: ToastType) => void;
  dismiss: (id: number) => void;
  setConfirm: (c: ConfirmState | null) => void;
}

let _id = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  confirm: null,
  push: (message, type = "info") => {
    const id = ++_id;
    set(s => ({ toasts: [...s.toasts.slice(-4), { id, message, type }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 3500);
  },
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  setConfirm: (c) => set({ confirm: c }),
}));

export function toast(message: string, type?: ToastType) {
  useToastStore.getState().push(message, type);
}

export function appConfirm(message: string): Promise<boolean> {
  return new Promise(resolve => {
    useToastStore.getState().setConfirm({ message, resolve });
  });
}

const ICON = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warning: <AlertTriangle size={16} />,
  error: <XCircle size={16} />,
};
const COLOR = {
  info: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  success: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  error: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts);
  const dismiss = useToastStore(s => s.dismiss);
  const confirm = useToastStore(s => s.confirm);
  const setConfirm = useToastStore(s => s.setConfirm);

  useEffect(() => {
    if (!confirm) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { confirm!.resolve(false); setConfirm(null); }
      if (e.key === "Enter") { confirm!.resolve(true); setConfirm(null); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, setConfirm]);

  return (
    <>
      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col-reverse gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur-sm animate-slide-up ${COLOR[t.type]}`}
          >
            <span className="shrink-0 opacity-80">{ICON[t.type]}</span>
            <span className="flex-1 min-w-0">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded-md p-0.5 opacity-50 hover:opacity-100 transition-opacity"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Confirm modal */}
      {confirm && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#2F2D29] p-5 shadow-2xl ring-1 ring-black/40 animate-scale-in">
            <div className="flex items-start gap-3 mb-5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300">
                <AlertTriangle size={18} />
              </div>
              <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line pt-1.5">{confirm.message}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { confirm.resolve(false); setConfirm(null); }}
                className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-white/5 transition-colors duration-200"
              >
                Cancel
              </button>
              <button
                autoFocus
                onClick={() => { confirm.resolve(true); setConfirm(null); }}
                className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white hover:bg-rose-400 hover:shadow-lg hover:shadow-rose-500/20 active:scale-[0.98] transition-all duration-200"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
