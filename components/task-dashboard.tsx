"use client";
import { useMemo, useState } from "react";
import { LayoutDashboard, ExternalLink, Download } from "lucide-react";
import { useOffice } from "@/store/office-store";
import { cn } from "@/lib/utils";

export function TaskDashboard() {
  const activeTaskId = useOffice(s => s.activeTaskId);
  const filesByTask = useOffice(s => s.filesByTask);
  const allFiles = activeTaskId ? filesByTask[activeTaskId] ?? [] : [];
  const dashboards = useMemo(
    () => allFiles.filter(f => /\.html?$/i.test(f.name)).sort((a, b) => b.mtime - a.mtime),
    [allFiles],
  );
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const currentName = selectedName ?? dashboards[0]?.name ?? null;

  if (!activeTaskId) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-8 max-w-[280px]">
          <LayoutDashboard size={28} className="mx-auto mb-2 text-slate-500" />
          <div className="text-sm font-semibold text-slate-100">No task open</div>
          <div className="mt-1.5 text-xs text-slate-400 leading-relaxed">
            Assign a task requesting a "dashboard" or call <code>export_dashboard</code> to
            create an interactive BI dashboard. <code>.html</code> files in the task will display here.
          </div>
        </div>
      </div>
    );
  }

  if (dashboards.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-8 max-w-[280px]">
          <LayoutDashboard size={28} className="mx-auto mb-2 text-slate-500" />
          <div className="text-sm font-semibold text-slate-100">No dashboard yet</div>
          <div className="mt-1.5 text-xs italic text-slate-400 leading-relaxed">
            Try: &quot;Create a dashboard summarizing this quarter&apos;s KPIs&quot;. The agent
            calls export_dashboard with a spec (kpis + charts + tables), and the
            HTML file appears here.
          </div>
        </div>
      </div>
    );
  }

  const iframeSrc = currentName
    ? `/api/files/${activeTaskId}/${encodeURIComponent(currentName)}`
    : "about:blank";

  return (
    <div className="task-dashboard">
      <div className="task-dashboard-header">
        {dashboards.length > 1 ? (
          <select
            value={currentName ?? ""}
            onChange={(e) => setSelectedName(e.target.value)}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-200"
          >
            {dashboards.map(f => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        ) : (
          <div className="truncate text-xs text-slate-300 font-medium">
            {currentName}
          </div>
        )}
        <div className="flex-1" />
        {currentName && (
          <>
            <a
              href={iframeSrc}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded p-1.5 text-slate-300 hover:bg-white/10"
              title="Open in new tab"
            >
              <ExternalLink size={12} />
            </a>
            <a
              href={iframeSrc}
              download={currentName}
              className="flex items-center gap-1 rounded p-1.5 text-slate-300 hover:bg-white/10"
              title="Download"
            >
              <Download size={12} />
            </a>
          </>
        )}
      </div>
      <iframe
        key={iframeSrc}
        src={iframeSrc}
        className={cn("task-dashboard-frame")}
        sandbox="allow-scripts allow-same-origin"
        title="Dashboard"
      />
    </div>
  );
}
