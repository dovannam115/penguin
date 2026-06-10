"use client";
import { Fragment, memo, useMemo, type MouseEvent } from "react";
import { marked } from "marked";
import { useOffice } from "@/store/office-store";
import { DesignChoices, type DesignChoicesData } from "./design-choices";
import { toast } from "@/components/toast";

const MENTION_RE = /@([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ0-9_]*)/g;

export function bossVariants(profile: { name: string; address: string }): Set<string> {
  const variants = new Set<string>();
  for (const w of [profile.address, profile.name]) {
    if (!w) continue;
    variants.add(w);
    variants.add(w.toLowerCase());
    variants.add(w.toUpperCase());
    variants.add(w[0].toUpperCase() + w.slice(1).toLowerCase());
  }
  return variants;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasBossPing(text: string, bossSet: Set<string>): boolean {
  // 1. Direct @-mention of the user — fires immediately, anywhere in the text.
  const re = new RegExp(MENTION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (bossSet.has(m[1])) return true;
  }
  // 2. Implicit question — last sentence ends with `?` AND addresses the user
  //    by their stored address/name (case-insensitive, word-bounded so "anh"
  //    doesn't accidentally match "thanh"). Catches "Anh muốn em làm sao?"
  //    even when the agent forgot to @-tag.
  const trimmed = text.trim();
  if (!trimmed.endsWith("?") && !trimmed.endsWith("？")) return false;
  const lastPara = trimmed.split(/\n\n+/).pop() ?? trimmed;
  const sentences = lastPara.split(/(?<=[.!?])\s+/);
  const lastSentence = (sentences[sentences.length - 1] ?? lastPara).toLowerCase();
  for (const variant of bossSet) {
    if (!variant) continue;
    if (new RegExp(`\\b${escapeRegex(variant.toLowerCase())}\\b`).test(lastSentence)) return true;
  }
  return false;
}

export function useBossSet(): Set<string> {
  const profile = useOffice(s => s.profile);
  return useMemo(() => bossVariants(profile), [profile]);
}

// marked v18 broke when we overrode Renderer methods directly (it dropped the
// `this.parser` binding inside the overrides and threw "parseInline of
// undefined"). Instead, render with the stock renderer and post-process the
// resulting HTML: force <a> to open in a new tab.
marked.setOptions({ gfm: true, breaks: true });

function postProcessHtml(html: string): string {
  // "Open template menu" trigger: a link to #mas-open-template becomes a
  // button-styled anchor. The click handler intercepts it and asks the LOCAL
  // server to open templates/index.html in the browser (file://, no localhost).
  html = html.replace(
    /<a href="#mas-open-template"[^>]*>[\s\S]*?<\/a>/g,
    '<a href="#mas-open-template" data-open-template="1" style="display:inline-flex;align-items:center;gap:.35em;background:rgba(16,163,74,.16);color:#34d399;padding:.3em .8em;border-radius:8px;font-weight:600;text-decoration:none;cursor:pointer">Open template menu</a>',
  );
  return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}

// The slide-template gallery is hosted as a standalone static site on
// Cloudflare Pages (always-on, independent of this app / the host PC). Clicking
// "Open template menu" opens that fixed public address in a new tab of the
// clicker's OWN browser — works locally and for any remote user, even if the
// main app is offline.
const TEMPLATE_GALLERY_URL = "https://penguin-templates.pages.dev";

function handleContentClick(e: MouseEvent<HTMLDivElement>) {
  if (!(e.target as HTMLElement).closest("a[data-open-template]")) return;
  e.preventDefault();
  const w = window.open(TEMPLATE_GALLERY_URL, "_blank", "noopener,noreferrer");
  if (!w) toast("Allow pop-ups to open the template menu", "error");
}

// Replace @mentions in the rendered HTML with styled spans, but skip inside
// <code> / <pre> blocks where "@" is meaningful as literal text.
function decorateMentions(html: string, bossSet: Set<string>): string {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>)/g);
  return parts
    .map(part => {
      if (part.startsWith("<pre") || part.startsWith("<code")) return part;
      return part.replace(MENTION_RE, (_m, name: string) => {
        const isBoss = bossSet.has(name);
        const cls = isBoss
          ? "mx-px rounded bg-amber-400/30 px-1 font-semibold text-amber-200 ring-1 ring-amber-400/40"
          : "mx-px rounded bg-sky-500/15 px-1 text-sky-300";
        return `<span class="${cls}">@${name}</span>`;
      });
    })
    .join("");
}

// Interactive design-choice picker is embedded via a fenced JSON block
// (```design-choices ... ```). Split the message into ordered segments so we
// can render plain text via marked + HTML while mounting <DesignChoices /> as
// a real React component for the choice block.
type Segment =
  | { kind: "text"; value: string }
  | { kind: "choices"; data: DesignChoicesData };

function parseSegments(text: string): Segment[] {
  const re = /```design-choices\s*\n([\s\S]*?)\n```/g;
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", value: text.slice(last, m.index) });
    }
    try {
      const data = JSON.parse(m[1]) as DesignChoicesData;
      if (data && Array.isArray(data.groups) && data.groups.length > 0) {
        out.push({ kind: "choices", data });
      } else {
        out.push({ kind: "text", value: m[0] });
      }
    } catch {
      // Stream-in-progress or malformed JSON — keep as text so it streams
      // gracefully instead of disappearing mid-token.
      out.push({ kind: "text", value: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: "text", value: text.slice(last) });
  }
  if (out.length === 0) {
    out.push({ kind: "text", value: text });
  }
  return out;
}

function renderTextSegment(value: string, bossSet: Set<string>): string {
  let md: string;
  try {
    md = marked.parse(value) as string;
  } catch {
    md = `<pre>${value.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))}</pre>`;
  }
  return decorateMentions(postProcessHtml(md), bossSet);
}

export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  const profile = useOffice(s => s.profile);
  const bossSet = useMemo(() => bossVariants(profile), [profile]);
  const segments = useMemo(() => parseSegments(text), [text]);
  // Fast path: pure text (no choice block). Keeps the common case as one
  // dangerouslySetInnerHTML, avoiding extra wrapper divs that could break
  // existing styles.
  if (segments.length === 1 && segments[0].kind === "text") {
    return (
      <div
        className="md-body selectable"
        onClick={handleContentClick}
        dangerouslySetInnerHTML={{ __html: renderTextSegment(segments[0].value, bossSet) }}
      />
    );
  }
  return (
    <div className="md-body selectable" onClick={handleContentClick}>
      {segments.map((seg, i) => {
        if (seg.kind === "choices") return <DesignChoices key={i} data={seg.data} />;
        return (
          <Fragment key={i}>
            <div dangerouslySetInnerHTML={{ __html: renderTextSegment(seg.value, bossSet) }} />
          </Fragment>
        );
      })}
    </div>
  );
});
