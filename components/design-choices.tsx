"use client";
import { useState } from "react";
import { useOffice } from "@/store/office-store";

export interface ChoiceOption {
  id: string;
  label: string;
  desc?: string;
}

export interface ChoiceGroup {
  id: string;
  label: string;
  options: ChoiceOption[];
}

export interface DesignChoicesData {
  intro?: string;
  groups: ChoiceGroup[];
}

// Render a card-style picker for design choices. Aria embeds a JSON block in
// her message; MessageContent parses it and mounts this component. When the
// user finishes picking, the composed text lands in the chat draft via
// pendingDraft so they can review/edit before sending.
export function DesignChoices({ data }: { data: DesignChoicesData }) {
  const setPendingDraft = useOffice(s => s.setPendingDraft);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const allPicked = data.groups.every(g => picks[g.id]);

  function handleSubmit() {
    const parts = data.groups.map(g => {
      const opt = g.options.find(o => o.id === picks[g.id]);
      return `${g.label}: ${opt?.label ?? ""}`;
    });
    setPendingDraft(`I picked ${parts.join(", ")}. Build with this combination.`);
  }

  return (
    <div className="my-3 rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-500/30 dark:bg-sky-950/20">
      {data.intro && (
        <p className="mb-4 text-sm text-sky-900 dark:text-sky-100">{data.intro}</p>
      )}
      <div className="space-y-4">
        {data.groups.map(g => (
          <div key={g.id}>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">
              {g.label}
            </h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {g.options.map(o => {
                const isSelected = picks[g.id] === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setPicks(p => ({ ...p, [g.id]: o.id }))}
                    className={
                      "rounded-md border p-3 text-left transition-colors " +
                      (isSelected
                        ? "border-sky-500 bg-sky-100 ring-1 ring-sky-500 dark:border-sky-400 dark:bg-sky-500/25 dark:ring-sky-400"
                        : "border-zinc-300 bg-white hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900/40 dark:hover:border-zinc-500")
                    }
                  >
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{o.label}</div>
                    {o.desc && (
                      <div className="mt-1 text-xs leading-snug text-zinc-600 dark:text-zinc-400">{o.desc}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!allPicked}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
        >
          Gửi lựa chọn
        </button>
        <span className="text-xs text-zinc-600 dark:text-zinc-500">
          {allPicked
            ? "Bấm Gửi, text điền vào ô soạn — anh có thể chỉnh trước khi Send"
            : `Chọn 1 option mỗi nhóm (${Object.keys(picks).length}/${data.groups.length})`}
        </span>
      </div>
    </div>
  );
}
