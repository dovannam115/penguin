"use client";
import { Sun, Moon } from "lucide-react";
import { useOffice } from "@/store/office-store";

interface Props {
  /** Optional label rendered next to the pill ("Theme" / "Giao diện"). */
  label?: string;
  /** Compact = no label, just the pill — for use in headers/toolbars. */
  compact?: boolean;
}

export function ThemeToggle({ label, compact }: Props) {
  const theme = useOffice(s => s.theme);
  const setTheme = useOffice(s => s.setTheme);

  function toggle() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  const pill = (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle"
      data-mode={theme}
      role="switch"
      aria-checked={theme === "dark"}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Đang ở chế độ ${theme === "dark" ? "Tối" : "Sáng"} — bấm để đổi`}
    >
      <span className="theme-toggle-track">
        <span className="theme-toggle-thumb" />
        <span className="theme-toggle-icons">
          <span className="theme-toggle-icon theme-toggle-icon-sun">
            <Sun size={14} strokeWidth={2.5} />
          </span>
          <span className="theme-toggle-icon theme-toggle-icon-moon">
            <Moon size={13} strokeWidth={2.5} />
          </span>
        </span>
      </span>
    </button>
  );

  if (compact) return pill;

  return (
    <div className="flex items-center justify-between gap-4">
      {label && (
        <div className="text-[13px] font-medium text-slate-200">{label}</div>
      )}
      {pill}
    </div>
  );
}
