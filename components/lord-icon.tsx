"use client";
import React, { useEffect, useState } from "react";

/**
 * Thin React wrapper for the Lordicon custom element. The script tag in
 * app/layout.tsx defines <lord-icon>; we create it via React.createElement
 * so React 19's stricter JSX intrinsic-elements check doesn't reject the
 * unknown tag at build time.
 *
 * Theme-aware colors: if the caller doesn't pass an explicit `colors` prop,
 * we feed Lordicon's primary + secondary slots a neutral gray that matches
 * whichever theme (.dark / .light) is on <html>. A MutationObserver re-renders
 * when the user flips the theme toggle so icons re-tint live.
 *
 * Usage:
 *   <LordIcon src="https://cdn.lordicon.com/vfiwitrm.json" size={20} />
 *   <LordIcon src="..." colors="primary:#7DD3FC,secondary:#FAFAF7" />
 *
 * Triggers: "hover" (default), "click", "loop", "in", "in-reveal", "morph",
 * "boomerang", "hover-pause", "morph-two-way".
 */

const THEME_COLORS = {
  dark:  "primary:#A19D93,secondary:#A19D93",   // warm slate-400 equivalent
  light: "primary:#5C5A53,secondary:#5C5A53",   // warm slate-700 equivalent
} as const;

interface Props {
  src: string;
  size?: number;
  trigger?: "hover" | "click" | "loop" | "in" | "in-reveal" | "morph" | "boomerang" | "hover-pause" | "morph-two-way";
  colors?: string;
  delay?: string | number;
  className?: string;
}

function useThemeMode(): "dark" | "light" {
  const [mode, setMode] = useState<"dark" | "light">("dark");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const read = () => setMode(root.classList.contains("light") ? "light" : "dark");
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return mode;
}

export function LordIcon({ src, size = 24, trigger = "hover", colors, delay, className }: Props) {
  const mode = useThemeMode();
  const effectiveColors = colors ?? THEME_COLORS[mode];

  return React.createElement("lord-icon", {
    src,
    trigger,
    colors: effectiveColors,
    delay,
    className,
    style: { width: size, height: size, display: "inline-block" },
  });
}
