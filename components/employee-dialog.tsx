"use client";
import { useCallback, useEffect, useState } from "react";
import type { Employee, ModelId } from "@/lib/types";
import { useOffice, type CustomSkill } from "@/store/office-store";
import { cn } from "@/lib/utils";
import { X, Trash2, AlertTriangle, ChevronRight, Plus, Download, Loader2, Pencil, RotateCcw } from "lucide-react";
import { appConfirm, toast } from "./toast";
import { SKILLS_LIBRARY, type Skill } from "@/lib/skills-library";
import { MODEL_REGISTRY, PROVIDER_LABEL, parseModel } from "@/lib/models";

const COLOR_PRESETS = [
  "#f472b6", "#fb7185", "#fbbf24", "#facc15",
  "#34d399", "#10b981", "#60a5fa", "#7dd3fc",
  "#a78bfa", "#c084fc", "#94a3b8", "#fcd34d",
];

const EMOJI_PRESETS = ["👤", "🎨", "💻", "📋", "🧠", "🔬", "📊", "✍️", "🛠️", "🚀", "🧪", "📣", "🧮", "🗂️"];

// Skill category labels + display order (skills are grouped by these).
const CATEGORY_LABEL: Record<Skill["category"], string> = {
  insurance: "Insurance",
  office: "Office",
  data: "Data",
  design: "Design",
  dev: "Dev",
  writing: "Writing",
  management: "Management",
  ops: "Ops",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL) as Skill["category"][];

interface Props {
  open: boolean;
  employee: Employee | null;
  onClose: () => void;
}

export function EmployeeDialog({ open, employee, onClose }: Props) {
  const upsert = useOffice(s => s.upsertEmployee);
  const remove = useOffice(s => s.removeEmployee);
  const customSkillsCount = useOffice(s => s.customSkills.length);

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState<ModelId>("claude-sonnet-4-6");
  const [avatarColor, setAvatarColor] = useState("#7dd3fc");
  const [emoji, setEmoji] = useState("👤");
  const [skills, setSkills] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && employee) {
      setName(employee.name);
      setRole(employee.role);
      setSystemPrompt(employee.systemPrompt);
      setModel(employee.model);
      setAvatarColor(employee.avatarColor);
      setEmoji(employee.emoji);
      setSkills(employee.skills ?? []);
    } else if (open) {
      setName("");
      setRole("");
      setSystemPrompt("");
      setModel("claude-sonnet-4-6");
      setAvatarColor(COLOR_PRESETS[Math.floor(Math.random() * COLOR_PRESETS.length)]);
      setEmoji("👤");
      setSkills([]);
    }
  }, [open, employee]);

  if (!open) return null;

  async function save() {
    if (!name.trim() || !role.trim() || !systemPrompt.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        role: role.trim(),
        systemPrompt: systemPrompt.trim(),
        model,
        avatarColor,
        emoji,
        skills,
      };
      const res = await fetch(employee ? `/api/employees/${employee.id}` : "/api/employees", {
        method: employee ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saved = await res.json();
      if (saved && saved.id) upsert(saved);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function del() {
    if (!employee) return;
    if (!(await appConfirm(`Delete ${employee.name}?`))) return;
    await fetch(`/api/employees/${employee.id}`, { method: "DELETE" });
    remove(employee.id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#2F2D29] shadow-2xl ring-1 ring-black/40 animate-scale-in">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">
            {employee ? "Edit Agent" : "Add Agent"}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100">
            <X size={17} />
          </button>
        </div>

        <div className="grid gap-3.5 p-5 max-h-[72vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Linh"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] outline-none transition focus:border-amber-400/60"
              />
            </Field>
            <Field label="Role">
              <input
                value={role}
                onChange={e => setRole(e.target.value)}
                placeholder="e.g. Product Designer"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] outline-none transition focus:border-amber-400/60"
              />
            </Field>
          </div>

          <Field label="System prompt">
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={6}
              placeholder="You are... You think about... @mention colleagues when you need input."
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] leading-relaxed outline-none transition focus:border-amber-400/60"
            />
          </Field>

          <Field label="Model">
            <ModelPicker value={model} onChange={setModel} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Avatar emoji">
              <div className="grid grid-cols-7 gap-1.5">
                {EMOJI_PRESETS.map(e => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEmoji(e)}
                    className={cn(
                      "flex h-8 items-center justify-center rounded-lg border text-base transition",
                      emoji === e ? "border-amber-400 bg-amber-400/10" : "border-white/10 bg-white/[0.03] hover:border-white/25"
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Color">
              <div className="grid grid-cols-6 gap-1.5">
                {COLOR_PRESETS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setAvatarColor(c)}
                    className={cn(
                      "h-8 rounded-lg border-2 transition",
                      avatarColor === c ? "border-white" : "border-white/10 hover:border-white/30"
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </Field>
          </div>

          <Field label={`Skills (${skills.length}/${SKILLS_LIBRARY.length + customSkillsCount})`}>
            <SkillPicker skills={skills} onChange={setSkills} />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/[0.07] px-5 py-3">
          <div>
            {employee && (
              <button
                onClick={del}
                className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/20"
              >
                <Trash2 size={14} /> Delete agent
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-white/5">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !name.trim() || !role.trim() || !systemPrompt.trim()}
              className="rounded-lg bg-amber-400 px-4 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : (employee ? "Update" : "Add agent")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Model picker: one grouped dropdown (Claude + OpenRouter) ────────────────
function ModelPicker({ value, onChange }: { value: ModelId; onChange: (m: ModelId) => void }) {
  const [openrouterKey, setOpenrouterKey] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((d: { hasOpenrouterKey?: boolean }) => setOpenrouterKey(!!d.hasOpenrouterKey))
      .catch(() => { /* keep defaults */ });
  }, []);

  const inRegistry = MODEL_REGISTRY.some(m => m.id === value);
  const needsKey = parseModel(value).provider === "openrouter" && !openrouterKey;
  const claudeModels = MODEL_REGISTRY.filter(m => m.provider === "claude");
  const openrouterModels = MODEL_REGISTRY.filter(m => m.provider === "openrouter");

  return (
    <div className="grid gap-1.5">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-slate-100 outline-none transition focus:border-amber-400/60"
      >
        {!inRegistry && (
          <option value={value} className="bg-[#2F2D29] text-slate-100">
            {parseModel(value).modelName} (custom)
          </option>
        )}
        <optgroup label={PROVIDER_LABEL.claude} className="bg-[#2a3350] text-slate-200">
          {claudeModels.map(m => (
            <option key={m.id} value={m.id} className="bg-[#2F2D29] text-slate-100">{m.label}</option>
          ))}
        </optgroup>
        <optgroup label={PROVIDER_LABEL.openrouter} className="bg-[#2a3350] text-slate-200">
          {openrouterModels.map(m => (
            <option key={m.id} value={m.id} className="bg-[#2F2D29] text-slate-100">{m.label}</option>
          ))}
        </optgroup>
      </select>
      {needsKey && (
        <div className="flex items-center gap-1.5 text-[10px] italic text-amber-300/90">
          <AlertTriangle size={11} className="not-italic shrink-0" />
          No OpenRouter API key yet. Add one in Settings before assigning tasks.
        </div>
      )}
    </div>
  );
}

// ── Skills, grouped by category into collapsible sections ──────────────────
function SkillPicker({ skills, onChange }: { skills: string[]; onChange: (s: string[]) => void }) {
  const customSkills = useOffice(s => s.customSkills);
  const removeCustomSkillStore = useOffice(s => s.removeCustomSkill);
  const skillOverrides = useOffice(s => s.skillOverrides);

  // Only built-in skills go into categories; custom skills get their own group
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const sk of SKILLS_LIBRARY) if (skills.includes(sk.id)) s.add(sk.category);
    if (customSkills.some(c => skills.includes(c.id))) s.add("__imported");
    return s;
  });

  const [importOpen, setImportOpen] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);

  const toggleCat = (cat: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });

  const toggleSkill = (id: string) =>
    onChange(skills.includes(id) ? skills.filter(x => x !== id) : [...skills, id]);

  const deleteCustomSkill = useCallback(async (id: string) => {
    if (!(await appConfirm("Delete this custom skill?"))) return;
    const res = await fetch(`/api/skills?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      removeCustomSkillStore(id);
      onChange(skills.filter(s => s !== id));
    }
  }, [skills, onChange, removeCustomSkillStore]);

  // Effective view of a skill (built-in + override applied). Used to display the
  // edited name/icon in the picker so user sees their customization at a glance.
  const effectiveName = (s: { id: string; name: string }) =>
    skillOverrides[s.id]?.name ?? s.name;
  const isEdited = (id: string) => !!skillOverrides[id];

  return (
    <div className="grid gap-0.5 rounded-xl border border-white/10 bg-white/[0.02] p-1.5">
      {/* Built-in categories */}
      {CATEGORY_ORDER.map(cat => {
        const catSkills = SKILLS_LIBRARY.filter(s => s.category === cat);
        if (catSkills.length === 0) return null;
        const isOpen = open.has(cat);
        const catActive = catSkills.filter(s => skills.includes(s.id)).length;
        return (
          <div key={cat}>
            <button
              type="button"
              onClick={() => toggleCat(cat)}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-slate-300 transition hover:bg-white/[0.04]"
            >
              <ChevronRight
                size={12}
                className={cn("shrink-0 text-slate-500 transition-transform", isOpen && "rotate-90")}
              />
              <span className="flex-1">{CATEGORY_LABEL[cat]}</span>
              {catActive > 0 && (
                <span className="rounded-full bg-amber-400/15 px-1.5 text-[10px] font-semibold text-amber-300">
                  {catActive}
                </span>
              )}
              <span className="text-[10px] text-slate-600">{catSkills.length}</span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-2 gap-1.5 px-1 pb-2 pt-0.5">
                {catSkills.map(s => {
                  const active = skills.includes(s.id);
                  const edited = isEdited(s.id);
                  return (
                    <div key={s.id} className="group/skill relative">
                      <button
                        type="button"
                        title={skillOverrides[s.id]?.description ?? s.description}
                        onClick={() => toggleSkill(s.id)}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[11px] font-medium transition",
                          active
                            ? "border-amber-400/60 bg-amber-400/10 text-slate-100"
                            : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/25 hover:text-slate-200"
                        )}
                      >
                        <span className="shrink-0 text-[13px] leading-none">{s.icon}</span>
                        <span className="truncate">{effectiveName(s)}</span>
                        {edited && (
                          <span
                            title="Đã chỉnh sửa nội dung skill"
                            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400"
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditingSkillId(s.id); }}
                        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-slate-200 ring-1 ring-white/10 hover:bg-amber-400 hover:text-slate-900 group-hover/skill:flex"
                        title="Sửa nội dung skill"
                      >
                        <Pencil size={9} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Imported (custom) skills — separate group */}
      {customSkills.length > 0 && (
        <div className="border-t border-white/5 pt-0.5">
          <button
            type="button"
            onClick={() => toggleCat("__imported")}
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-teal-300 transition hover:bg-teal-400/5"
          >
            <ChevronRight
              size={12}
              className={cn("shrink-0 text-teal-400/60 transition-transform", open.has("__imported") && "rotate-90")}
            />
            <Download size={11} className="shrink-0 text-teal-400/60" />
            <span className="flex-1">Imported</span>
            {customSkills.filter(s => skills.includes(s.id)).length > 0 && (
              <span className="rounded-full bg-teal-400/15 px-1.5 text-[10px] font-semibold text-teal-300">
                {customSkills.filter(s => skills.includes(s.id)).length}
              </span>
            )}
            <span className="text-[10px] text-slate-600">{customSkills.length}</span>
          </button>
          {open.has("__imported") && (
            <div className="grid grid-cols-2 gap-1.5 px-1 pb-2 pt-0.5">
              {customSkills.map(c => {
                const active = skills.includes(c.id);
                return (
                  <div key={c.id} className="group/skill relative">
                    <button
                      type="button"
                      title={c.description || c.source}
                      onClick={() => toggleSkill(c.id)}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[11px] font-medium transition",
                        active
                          ? "border-teal-400/60 bg-teal-400/10 text-slate-100"
                          : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/25 hover:text-slate-200"
                      )}
                    >
                      <span className="shrink-0 text-[13px] leading-none">{c.icon}</span>
                      <span className="truncate">{c.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setEditingSkillId(c.id); }}
                      className="absolute -right-1 top-3 hidden h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-slate-200 ring-1 ring-white/10 hover:bg-teal-400 hover:text-slate-900 group-hover/skill:flex"
                      title="Sửa nội dung skill"
                    >
                      <Pencil size={9} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deleteCustomSkill(c.id); }}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white group-hover/skill:flex"
                      title="Xóa custom skill"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Import / Add custom skill */}
      <div className="border-t border-white/5 pt-1">
        <button
          type="button"
          onClick={() => setImportOpen(o => !o)}
          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-teal-300 transition hover:bg-teal-400/10"
        >
          <Plus size={12} />
          <span className="flex-1">Add custom skill</span>
          <span className="text-[10px] text-slate-500">{customSkills.length} imported</span>
        </button>
        {importOpen && (
          <SkillImportPanel
            onImported={(id) => toggleSkill(id)}
            onClose={() => setImportOpen(false)}
          />
        )}
      </div>

      {editingSkillId && (
        <SkillEditModal
          skillId={editingSkillId}
          onClose={() => setEditingSkillId(null)}
        />
      )}
    </div>
  );
}

// ── Skill edit modal: edit prompt/name/description of a built-in or custom skill ──
function SkillEditModal({ skillId, onClose }: { skillId: string; onClose: () => void }) {
  const isCustom = skillId.startsWith("custom-");
  const customSkills = useOffice(s => s.customSkills);
  const skillOverrides = useOffice(s => s.skillOverrides);
  const updateCustomSkill = useOffice(s => s.updateCustomSkill);
  const removeCustomSkill = useOffice(s => s.removeCustomSkill);
  const upsertSkillOverride = useOffice(s => s.upsertSkillOverride);
  const removeSkillOverride = useOffice(s => s.removeSkillOverride);

  const builtIn = !isCustom ? SKILLS_LIBRARY.find(s => s.id === skillId) : null;
  const custom = isCustom ? customSkills.find(s => s.id === skillId) : null;
  const override = !isCustom ? skillOverrides[skillId] : null;

  const base = builtIn ?? custom;
  if (!base) {
    return null;
  }

  // Built-in: start with override values if any, else library default.
  // Custom: start with current row.
  const initialName = (override?.name ?? null) !== null ? (override!.name as string) : base.name;
  const initialDesc = (override?.description ?? null) !== null ? (override!.description as string) : base.description;
  const initialPrompt = (override?.prompt ?? null) !== null ? (override!.prompt as string) : base.prompt;

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDesc);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [saving, setSaving] = useState(false);

  const promptIsDefault = prompt === base.prompt;
  const nameIsDefault = name === base.name;
  const descIsDefault = description === base.description;
  const anyChange = !promptIsDefault || !nameIsDefault || !descIsDefault;

  async function save() {
    if (!prompt.trim()) {
      toast("Prompt không được để trống", "warning");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, string> = {
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
      };
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Lưu thất bại", "error");
        return;
      }
      const data = await res.json();
      if (isCustom) {
        updateCustomSkill(data as CustomSkill);
        toast("Đã lưu custom skill", "success");
      } else {
        // For built-in: store the effective override (may differ from sent body
        // if the server stripped fields that match the default).
        if (data?.override) upsertSkillOverride(data.override);
        toast("Đã lưu override skill", "success");
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!(await appConfirm("Reset skill về bản gốc? Toàn bộ chỉnh sửa của skill này sẽ mất."))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Reset thất bại", "error");
        return;
      }
      if (isCustom) {
        removeCustomSkill(skillId);
        toast("Đã xóa custom skill", "success");
      } else {
        removeSkillOverride(skillId);
        toast("Đã reset về bản gốc", "success");
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#2F2D29] shadow-2xl ring-1 ring-black/40 animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Pencil size={15} className="text-amber-300" />
            <span className="text-[15px] font-semibold tracking-tight">
              Sửa skill
            </span>
            <span className="text-[12px] text-slate-500 font-mono">{base.icon} {skillId}</span>
            {!isCustom && override && (
              <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
                Đã chỉnh
              </span>
            )}
            {isCustom && (
              <span className="rounded-full bg-teal-400/15 px-2 py-0.5 text-[10px] font-semibold text-teal-300">
                Custom
              </span>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100">
            <X size={17} />
          </button>
        </div>

        <div className="grid gap-4 p-5 max-h-[75vh] overflow-y-auto">
          <label className="block">
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-slate-400">
              <span>Tên skill</span>
              {!nameIsDefault && (
                <button
                  type="button"
                  onClick={() => setName(base.name)}
                  className="flex items-center gap-1 text-[10px] normal-case tracking-normal text-slate-500 hover:text-slate-300"
                  title="Reset field về default"
                >
                  <RotateCcw size={10} /> reset field
                </button>
              )}
            </div>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none transition focus:border-amber-400/60"
            />
          </label>

          <label className="block">
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-slate-400">
              <span>Mô tả ngắn</span>
              {!descIsDefault && (
                <button
                  type="button"
                  onClick={() => setDescription(base.description)}
                  className="flex items-center gap-1 text-[10px] normal-case tracking-normal text-slate-500 hover:text-slate-300"
                >
                  <RotateCcw size={10} /> reset field
                </button>
              )}
            </div>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none transition focus:border-amber-400/60"
            />
          </label>

          <label className="block">
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-slate-400">
              <span>Prompt (nội dung skill agent dùng)</span>
              {!promptIsDefault && (
                <button
                  type="button"
                  onClick={() => setPrompt(base.prompt)}
                  className="flex items-center gap-1 text-[10px] normal-case tracking-normal text-slate-500 hover:text-slate-300"
                >
                  <RotateCcw size={10} /> reset field
                </button>
              )}
            </div>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={18}
              className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[12px] leading-relaxed outline-none transition focus:border-amber-400/60"
              spellCheck={false}
            />
            <div className="mt-1 text-[10px] text-slate-500">
              {prompt.length.toLocaleString()} ký tự · {promptIsDefault ? "đang là default" : "đã chỉnh"}
            </div>
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/[0.07] px-5 py-3">
          <div className="flex items-center gap-2">
            {(isCustom || override) && (
              <button
                type="button"
                onClick={resetToDefault}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-1.5 text-[12px] font-medium text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
              >
                {isCustom ? <Trash2 size={12} /> : <RotateCcw size={12} />}
                {isCustom ? "Xóa skill" : "Reset về default"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-slate-300 hover:bg-white/5"
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !anyChange}
              className="flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-[12px] font-semibold text-slate-900 transition hover:bg-amber-300 disabled:opacity-50"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              Lưu
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Import panel: npx command OR manual entry ──────────────────
function SkillImportPanel({
  onImported,
  onClose,
}: {
  onImported: (skillId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"import" | "manual">("import");
  const [cmdInput, setCmdInput] = useState("");
  const [importing, setImporting] = useState(false);

  const [manualName, setManualName] = useState("");
  const [manualCategory, setManualCategory] = useState("ops");
  const [manualIcon, setManualIcon] = useState("🔧");
  const [manualPrompt, setManualPrompt] = useState("");
  const [manualSaving, setManualSaving] = useState(false);

  const runImport = async () => {
    if (!cmdInput.trim()) return;
    setImporting(true);
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmdInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || "Import failed", "error");
        return;
      }
      const imported = data.imported as Array<{ id: string; name: string }>;
      toast(`Imported ${imported.length} skill(s): ${imported.map(s => s.name).join(", ")}`, "success");
      // Reload custom skills from server (replaces the full list)
      const listRes = await fetch("/api/skills");
      if (listRes.ok) {
        const all = await listRes.json() as CustomSkill[];
        useOffice.getState().setCustomSkills(all);
      }
      if (imported[0]?.id) onImported(imported[0].id);
      setCmdInput("");
      onClose();
    } finally {
      setImporting(false);
    }
  };

  const saveManual = async () => {
    if (!manualName.trim() || !manualPrompt.trim()) {
      toast("Name and prompt are required", "warning");
      return;
    }
    setManualSaving(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: manualName.trim(),
          icon: manualIcon || "🔧",
          category: manualCategory,
          description: "",
          prompt: manualPrompt.trim(),
          source: "manual",
        }),
      });
      if (!res.ok) {
        toast("Save failed", "error");
        return;
      }
      const skill = await res.json() as CustomSkill;
      useOffice.getState().addCustomSkill(skill);
      onImported(skill.id);
      toast(`Skill "${skill.name}" created`, "success");
      setManualName("");
      setManualPrompt("");
      onClose();
    } finally {
      setManualSaving(false);
    }
  };

  return (
    <div className="mx-1 mb-1 rounded-lg border border-white/10 bg-[#0d1225] p-3 animate-scale-in">
      {/* Tabs */}
      <div className="mb-3 flex gap-1 rounded-lg bg-white/[0.03] p-0.5">
        <button
          type="button"
          onClick={() => setTab("import")}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
            tab === "import" ? "bg-teal-400/15 text-teal-300" : "text-slate-400 hover:text-slate-200"
          )}
        >
          <Download size={10} className="mr-1 inline" /> Import (npx)
        </button>
        <button
          type="button"
          onClick={() => setTab("manual")}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
            tab === "manual" ? "bg-teal-400/15 text-teal-300" : "text-slate-400 hover:text-slate-200"
          )}
        >
          <Plus size={10} className="mr-1 inline" /> Manual
        </button>
      </div>

      {tab === "import" ? (
        <div className="flex flex-col gap-2">
          <div className="text-[10px] text-slate-500">
            Paste an aitmpl.com command or just the skill path
          </div>
          <input
            type="text"
            value={cmdInput}
            onChange={e => setCmdInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") runImport(); }}
            placeholder="npx claude-code-templates@latest --skill creative-design/frontend-design"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-400/40"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={onClose} className="rounded-lg px-2.5 py-1 text-[11px] text-slate-400 hover:bg-white/5">
              Cancel
            </button>
            <button
              type="button"
              onClick={runImport}
              disabled={!cmdInput.trim() || importing}
              className="flex items-center gap-1 rounded-lg bg-teal-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-teal-400 disabled:opacity-40"
            >
              {importing && <Loader2 size={11} className="animate-spin" />}
              {importing ? "Importing..." : "Import"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={manualIcon}
              onChange={e => setManualIcon(e.target.value)}
              className="w-10 rounded-lg border border-white/10 bg-white/[0.03] px-1 py-1.5 text-center text-[14px] outline-none focus:border-teal-400/40"
              title="Icon (emoji)"
            />
            <input
              type="text"
              value={manualName}
              onChange={e => setManualName(e.target.value)}
              placeholder="Skill name"
              className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-400/40"
            />
            <select
              value={manualCategory}
              onChange={e => setManualCategory(e.target.value)}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px] text-slate-300 outline-none focus:border-teal-400/40"
            >
              {CATEGORY_ORDER.map(cat => (
                <option key={cat} value={cat}>{CATEGORY_LABEL[cat]}</option>
              ))}
            </select>
          </div>
          <textarea
            value={manualPrompt}
            onChange={e => setManualPrompt(e.target.value)}
            placeholder="Skill prompt (instructions the agent will follow)..."
            rows={5}
            className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-400/40"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={onClose} className="rounded-lg px-2.5 py-1 text-[11px] text-slate-400 hover:bg-white/5">
              Cancel
            </button>
            <button
              type="button"
              onClick={saveManual}
              disabled={!manualName.trim() || !manualPrompt.trim() || manualSaving}
              className="flex items-center gap-1 rounded-lg bg-teal-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-teal-400 disabled:opacity-40"
            >
              {manualSaving && <Loader2 size={11} className="animate-spin" />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </div>
      {children}
      {hint && (
        <div className="mt-1 text-[10px] italic leading-snug text-slate-500">{hint}</div>
      )}
    </label>
  );
}
