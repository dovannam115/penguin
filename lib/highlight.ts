/**
 * highlight — tiny, dependency-free syntax highlighter for the streaming code
 * "tail" preview (components/chat-drawer.tsx → CodeTail). It must tolerate
 * PARTIAL / mid-token input (the stream shows only the last few lines, often
 * starting or ending in the middle of a tag/string), so it never throws and
 * degrades to plain escaped text. Returns HTML with <span class="tok-*">
 * wrappers; the token colours live in globals.css (themed for dark + light).
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESC[c]);
}
function span(cls: string, s: string): string {
  return `<span class="${cls}">${esc(s)}</span>`;
}

/** One opening/closing tag (or partial) → coloured tag name + attrs + strings. */
function highlightTag(seg: string): string {
  const openM = /^<\/?/.exec(seg);
  const open = openM ? openM[0] : "<";
  let out = span("tok-punct", open);
  let i = open.length;
  const nameM = /^[a-zA-Z][\w:.-]*/.exec(seg.slice(i));
  if (nameM) { out += span("tok-tag", nameM[0]); i += nameM[0].length; }
  while (i < seg.length) {
    const s = seg.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\s+/.exec(s))) { out += m[0]; i += m[0].length; }
    else if ((m = /^\/?>/.exec(s))) { out += span("tok-punct", m[0]); i += m[0].length; }
    else if (s[0] === "=") { out += span("tok-punct", "="); i += 1; }
    else if ((m = /^"[^"]*"?|^'[^']*'?/.exec(s))) { out += span("tok-str", m[0]); i += m[0].length; }
    else if ((m = /^[^\s=>/]+/.exec(s))) { out += span("tok-attr", m[0]); i += m[0].length; }
    else { out += esc(s[0]); i += 1; }
  }
  return out;
}

function highlightHtml(code: string): string {
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    if (code[i] === "<") {
      if (code.startsWith("<!--", i)) {
        const end = code.indexOf("-->", i + 4);
        const stop = end === -1 ? n : end + 3;
        out += span("tok-comment", code.slice(i, stop));
        i = stop; continue;
      }
      const gt = code.indexOf(">", i);
      const stop = gt === -1 ? n : gt + 1;
      out += highlightTag(code.slice(i, stop));
      i = stop; continue;
    }
    const next = code.indexOf("<", i);
    const stop = next === -1 ? n : next;
    out += esc(code.slice(i, stop));
    i = stop;
  }
  return out;
}

const KEYWORDS = new Set([
  "const","let","var","function","return","if","else","for","while","do","switch",
  "case","break","continue","new","class","extends","import","from","export","default",
  "async","await","try","catch","finally","throw","typeof","instanceof","in","of","this",
  "null","undefined","true","false","void","yield","static","get","set",
  "def","lambda","None","True","False","elif","with","as","pass","raise","global","nonlocal","print","self","not","and","or","is","del",
]);

function highlightGeneric(code: string, lang: string): string {
  const hashComment = ["python","py","bash","sh","yaml","yml","toml","ruby","rb"].includes(lang);
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    // block comment /* ... */
    if (c === "/" && code[i + 1] === "*") {
      const e = code.indexOf("*/", i + 2);
      const stop = e === -1 ? n : e + 2;
      out += span("tok-comment", code.slice(i, stop)); i = stop; continue;
    }
    // line comment // ...  or  # ... (only in hash-comment langs)
    if ((c === "/" && code[i + 1] === "/") || (hashComment && c === "#")) {
      const e = code.indexOf("\n", i);
      const stop = e === -1 ? n : e;
      out += span("tok-comment", code.slice(i, stop)); i = stop; continue;
    }
    // strings (tolerate unterminated at the tail end)
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && code[j] !== c) { if (code[j] === "\\") j++; j++; }
      const stop = Math.min(j + 1, n);
      out += span("tok-str", code.slice(i, stop)); i = stop; continue;
    }
    // numbers (not when part of an identifier)
    if (/[0-9]/.test(c) && (i === 0 || /[^a-zA-Z_$]/.test(code[i - 1]))) {
      const m = /^[0-9][\w.]*/.exec(code.slice(i))!;
      out += span("tok-num", m[0]); i += m[0].length; continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_$]/.test(c)) {
      const m = /^[a-zA-Z_$][\w$]*/.exec(code.slice(i))!;
      out += KEYWORDS.has(m[0]) ? span("tok-kw", m[0]) : esc(m[0]);
      i += m[0].length; continue;
    }
    out += esc(c); i += 1;
  }
  return out;
}

/** Highlight a code fragment to HTML. `lang` is the id from extLang() (html,
 *  css, js, ts, tsx, jsx, python, json, bash, yaml, sql, markdown, text…). */
export function highlightCode(code: string, lang: string): string {
  const l = (lang || "").toLowerCase();
  if (l === "html" || l === "htm" || l === "xml" || l === "svg" ||
      ((l === "" || l === "text") && /^\s*<[a-zA-Z!/]/.test(code))) {
    return highlightHtml(code);
  }
  return highlightGeneric(code, l);
}
