"use client";
import { useState } from "react";
import { RefreshCw, Cpu, Sparkles, FileText } from "lucide-react";
import { useOffice } from "@/store/office-store";
import { getSkillById, type Skill, type SkillOverrideMap } from "@/lib/skills-library";
import { modelLabel, modelProvider, PROVIDER_LABEL } from "@/lib/models";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { Employee } from "@/lib/types";

interface Props {
  employee: Employee;
}

export function AgentInfoPane({ employee }: Props) {
  const customSkills = useOffice(s => s.customSkills);
  const skillOverrides = useOffice(s => s.skillOverrides);
  const setEmployees = useOffice(s => s.setEmployees);

  const [refreshing, setRefreshing] = useState(false);

  // SkillOverride[] from store keyed by id → SkillOverrideMap shape getSkillById wants.
  const overrideMap: SkillOverrideMap = Object.fromEntries(
    Object.entries(skillOverrides).map(([id, o]) => [id, {
      name: o.name, description: o.description, prompt: o.prompt,
    }])
  );

  // CustomSkill has a wider `category: string`; getSkillById only reads
  // name/description/prompt/icon, so the structural mismatch is harmless.
  const skills = (employee.skills ?? [])
    .map(id => getSkillById(id, customSkills as unknown as Skill[], overrideMap))
    .filter((s): s is Skill => !!s);

  const provider = modelProvider(employee.model);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/employees");
      if (!res.ok) {
        toast("Couldn't refresh", "error");
        return;
      }
      const list = (await res.json()) as Employee[];
      setEmployees(list);
    } catch {
      toast("Couldn't refresh", "error");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      {/* Hero */}
      <div className="flex items-start gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-[26px] ring-1 ring-black/30"
          style={{ backgroundColor: employee.avatarColor }}
        >
          {employee.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold tracking-tight text-slate-100">
            {employee.name}
          </div>
          <div className="mt-0.5 truncate text-[13px] text-slate-400">{employee.role}</div>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className={cn(
            "shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-300 transition",
            "hover:border-white/20 hover:bg-white/[0.06] hover:text-slate-100",
            "disabled:opacity-50",
          )}
          title="Refresh after editing the agent"
        >
          <span className="flex items-center gap-1.5">
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </span>
        </button>
      </div>

      {/* Model */}
      <div className="mt-6 flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
        <Cpu size={14} className="text-teal-300" />
        <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Model</div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[13px] font-medium text-slate-100">{modelLabel(employee.model)}</span>
          <span className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            provider === "claude"
              ? "bg-amber-400/15 text-amber-300"
              : "bg-teal-400/15 text-teal-300",
          )}>
            {PROVIDER_LABEL[provider]}
          </span>
        </div>
      </div>

      {/* Description */}
      <div className="mt-5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
          <FileText size={11} />
          Description
        </div>
        {employee.systemPrompt.trim() ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-[12.5px] leading-relaxed text-slate-300 whitespace-pre-wrap selectable">
            {employee.systemPrompt}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-3.5 text-[12px] italic text-slate-500">
            No description yet. Click edit in the top bar to add one.
          </div>
        )}
      </div>

      {/* Skills */}
      <div className="mt-5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
          <Sparkles size={11} />
          Installed skills <span className="text-slate-600">· {skills.length}</span>
        </div>
        {skills.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-3.5 text-[12px] italic text-slate-500">
            No skills installed. Click edit agent to add some.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {skills.map(s => (
              <div
                key={s.id}
                className="flex items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"
              >
                <div className="text-[18px] leading-none">{s.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-slate-200">{s.name}</div>
                  <div className="line-clamp-2 text-[11px] leading-snug text-slate-500">{s.description}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
