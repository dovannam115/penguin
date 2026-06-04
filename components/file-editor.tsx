"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { html as cmHtml } from "@codemirror/lang-html";
import { css as cmCss } from "@codemirror/lang-css";
import { javascript as cmJs } from "@codemirror/lang-javascript";
import { markdown as cmMd } from "@codemirror/lang-markdown";
import { json as cmJson } from "@codemirror/lang-json";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { FileText, Save, X, RotateCcw, MousePointerClick, ChevronLeft, ChevronRight, ChevronDown, Undo2, Redo2, Maximize2, Minimize2, Trash2 } from "lucide-react";
import type { FileInfo } from "@/store/office-store";
import { toast, appConfirm } from "./toast";
import { cn } from "@/lib/utils";

function langFor(ext: string) {
  switch (ext) {
    case "html": case "htm": case "svg": case "xml": return cmHtml();
    case "css": return cmCss();
    case "js": case "mjs": return cmJs();
    case "md": case "markdown": return cmMd();
    case "json": return cmJson();
    default: return [];
  }
}

interface OpenTag { start: number; end: number; name: string; attrs: string; line: number }

/**
 * Single source of truth for tag identity: walk the HTML once and return every
 * OPENING tag (outside <script>/<style>) in document order with its char range,
 * tag name, attribute string, and 1-based line. Quote-aware (`>` inside an
 * attribute value doesn't end the tag) and handles tags spanning multiple lines.
 * Both `injectLineMarkers` (preview) and `setStyleProp` (write-back) use this,
 * so the K-th tag is GUARANTEED identical on both sides → no index drift.
 */
function scanOpenTags(html: string): OpenTag[] {
  const tags: OpenTag[] = [];
  const n = html.length;
  let i = 0, line = 1;
  const bumpLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (html[k] === "\n") line++;
  };
  while (i < n) {
    if (html[i] !== "<") { if (html[i] === "\n") line++; i++; continue; }
    const next = html[i + 1];
    if (next === "!") { // comment / doctype
      const gt = html.indexOf(">", i);
      if (gt === -1) break;
      bumpLines(i, gt + 1); i = gt + 1; continue;
    }
    if (next === "/") { // closing tag
      const gt = html.indexOf(">", i);
      if (gt === -1) break;
      bumpLines(i, gt + 1); i = gt + 1; continue;
    }
    const nm = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i, i + 60));
    if (!nm) { i++; continue; }
    const start = i;
    const name = nm[1];
    let j = i + nm[0].length, quote = "";
    while (j < n) {
      const c = html[j];
      if (quote) { if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    const end = Math.min(j + 1, n);
    const attrs = html.slice(start + 1 + name.length, j);
    const startLine = line;
    bumpLines(start, end);
    i = end;
    tags.push({ start, end, name, attrs, line: startLine });
    // skip <script>/<style> bodies so tags inside them aren't counted
    const low = name.toLowerCase();
    if (low === "script" || low === "style") {
      const close = new RegExp("</" + low + "\\s*>", "i").exec(html.slice(i));
      if (close) { const skipEnd = i + close.index + close[0].length; bumpLines(i, skipEnd); i = skipEnd; }
      else i = n;
    }
  }
  return tags;
}

/** Inject `data-cm-line` (Inspect → jump) + `data-ed` (Visual → property panel)
 *  into each opening tag, using scanOpenTags so the `data-ed` index matches
 *  setStyleProp exactly. */
function injectLineMarkers(html: string): string {
  const tags = scanOpenTags(html);
  let out = "", pos = 0;
  tags.forEach((t, k) => {
    const insertAt = t.start + 1 + t.name.length;
    out += html.slice(pos, insertAt) + ` data-cm-line="${t.line}" data-ed="${k}"`;
    pos = insertAt;
  });
  return out + html.slice(pos);
}

/** Merge `prop: value` into the inline style of the K-th opening tag (same index
 *  as data-ed). Empty value removes the property. */
function setStyleProp(html: string, edIndex: number, prop: string, value: string): string {
  const tags = scanOpenTags(html);
  const t = tags[edIndex];
  if (!t) return html;
  const newTag = `<${t.name}${mergeStyleAttr(t.attrs, prop, value)}>`;
  return html.slice(0, t.start) + newTag + html.slice(t.end);
}

/** Replace the text of the K-th opening tag's element (leaf only — the iframe
 *  only marks elements without child ELEMENTS as editable, so the content is
 *  pure text and the first `</tag>` after the open tag is its real close). */
function setTextContent(html: string, edIndex: number, text: string): string {
  const tags = scanOpenTags(html);
  const t = tags[edIndex];
  if (!t) return html;
  const m = new RegExp("</" + t.name + "\\s*>", "i").exec(html.slice(t.end));
  if (!m) return html;
  const closeStart = t.end + m.index;
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.slice(0, t.end) + esc + html.slice(closeStart);
}

/** Char range [start, end) of the WHOLE element at edIndex — open tag, children,
 *  and matching close tag — by depth-matching same-name tags. Void/self-closing
 *  elements return just their open tag. Used by Duplicate. */
function elementOuterRange(html: string, edIndex: number): [number, number] | null {
  const tags = scanOpenTags(html);
  const t = tags[edIndex];
  if (!t) return null;
  const name = t.name.toLowerCase();
  const voids = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  if (voids.has(name) || /\/\s*>$/.test(html.slice(t.start, t.end))) return [t.start, t.end];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("<(/?)" + esc + "(?=[\\s/>])", "gi");
  re.lastIndex = t.end;
  let depth = 1, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const gt = html.indexOf(">", m.index);
    if (gt === -1) break;
    if (m[1] === "/") { if (--depth === 0) return [t.start, gt + 1]; }
    else if (html[gt - 1] !== "/") depth++;
  }
  return [t.start, html.length];
}

/** Merge one CSS property into a tag's attribute string (the part after the tag
 *  name, before `>`). Preserves other attributes and other style props. */
function mergeStyleAttr(attrs: string, prop: string, value: string): string {
  const styleRe = /\s+style\s*=\s*("([^"]*)"|'([^']*)')/i;
  const m = attrs.match(styleRe);
  const decls = new Map<string, string>();
  if (m) {
    const body = m[2] ?? m[3] ?? "";
    for (const part of body.split(";")) {
      const idx = part.indexOf(":");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim().toLowerCase();
      const v = part.slice(idx + 1).trim();
      if (k) decls.set(k, v);
    }
  }
  if (value.trim() === "") decls.delete(prop.toLowerCase());
  else decls.set(prop.toLowerCase(), value.trim());
  const styleStr = Array.from(decls.entries()).map(([k, v]) => `${k}: ${v}`).join("; ");
  const rest = m ? attrs.replace(styleRe, "") : attrs;
  return styleStr ? `${rest} style="${styleStr}"` : rest;
}

/** Insert `block` as the FIRST CHILD of the element at edIndex (right after its
 *  open tag), indented one level past the parent. Returns null if the element is
 *  missing or a void tag (can't hold children). Used to drop an image into a
 *  frame (Canva-style fill). */
function insertFirstChild(html: string, edIndex: number, block: string): string | null {
  const tags = scanOpenTags(html);
  const t = tags[edIndex];
  if (!t) return null;
  const voids = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  if (voids.has(t.name.toLowerCase()) || /\/\s*>$/.test(html.slice(t.start, t.end))) return null;
  const lineStart = html.lastIndexOf("\n", t.start - 1) + 1;
  const indent = (html.slice(lineStart, t.start).match(/^\s*/)?.[0] ?? "") + "  ";
  return html.slice(0, t.end) + "\n" + indent + block + html.slice(t.end);
}

/** Set/replace a plain attribute (e.g. `src`) on the open tag at edIndex. The
 *  value is wrapped in double quotes — fine for data URLs (no `"` inside). */
function setTagAttr(html: string, edIndex: number, attr: string, value: string): string {
  const tags = scanOpenTags(html);
  const t = tags[edIndex];
  if (!t) return html;
  const re = new RegExp(`\\s+${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  const decl = ` ${attr}="${value}"`;
  const attrs = re.test(t.attrs) ? t.attrs.replace(re, decl) : decl + t.attrs;
  return html.slice(0, t.start) + `<${t.name}${attrs}>` + html.slice(t.end);
}

const INSPECT_SCRIPT = `<script>
(function(){
  // Inject AI busy styles once: blurred box overlay with a conic gradient
  // "marching" around the perimeter (modern AI-in-progress vibe).
  if (!document.getElementById('cm-ai-sparkle-style')) {
    var st = document.createElement('style');
    st.id = 'cm-ai-sparkle-style';
    st.textContent = '@property --cm-ai-angle{syntax:"<angle>";initial-value:0deg;inherits:false}@keyframes cm-ai-rotate{to{--cm-ai-angle:360deg}}.cm-ai-box{position:fixed;pointer-events:none;z-index:2147483645;border-radius:8px;padding:0;background:linear-gradient(rgba(255,255,255,.04),rgba(255,255,255,.04)) padding-box,conic-gradient(from var(--cm-ai-angle,0deg),#a78bfa,#38bdf8,#f0abfc,#facc15,#a78bfa) border-box;border:1.5px solid transparent;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);animation:cm-ai-rotate 2.4s linear infinite;will-change:left,top,width,height,--cm-ai-angle;box-shadow:0 0 18px rgba(167,139,250,.22)}';
    document.head.appendChild(st);
  }
  // mode: 'inspect' (click -> jump to code), 'visual' (click -> property panel),
  // or 'off' (preview interactive normally). Seeded by the parent on (re)load so
  // a reload during Visual mode stays in Visual mode (no race with postMessage).
  var mode = window.__cmMode || 'inspect';
  var hovered = null, selected = null;
  var drag = null;            // active drag state {sx,sy,bx,by,moved} or null
  var suppressClick = false;  // eat the click that fires right after a drag
  function clearHover(){
    if (!hovered) return;
    if (hovered !== selected){ hovered.style.outline=''; hovered.style.outlineOffset=''; }
    hovered.style.cursor=''; hovered = null;
  }
  function clearSelected(){
    if (!selected) return;
    selected.style.outline=''; selected.style.outlineOffset=''; selected.style.cursor='';
    selected.style.resize=''; selected.style.overflow=''; selected = null;
  }
  function hex(c){
    var m = (c||'').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return '';
    var p = m[1].split(',').map(function(x){return parseFloat(x);});
    if (p.length>=4 && p[3]===0) return '';
    function h(n){ return ('0'+Math.round(n).toString(16)).slice(-2); }
    return '#'+h(p[0])+h(p[1])+h(p[2]);
  }
  var resizing = false;       // true while the bottom-right corner is dragged
  var rz = null;              // resize start metrics {sx,sy,w0,h0,img}
  // Net translate of the element in CSS px, read from the computed matrix.
  function translatePx(el){
    var t = getComputedStyle(el).transform;
    if (!t || t === 'none') return { x:0, y:0 };
    var m = t.match(/matrix\\(([^)]+)\\)/);
    if (m){ var p = m[1].split(',').map(parseFloat); return { x:p[4]||0, y:p[5]||0 }; }
    var m3 = t.match(/matrix3d\\(([^)]+)\\)/);
    if (m3){ var q = m3[1].split(',').map(parseFloat); return { x:q[12]||0, y:q[13]||0 }; }
    return { x:0, y:0 };
  }
  // px -> vw/vh (the slide is 100vw x 100vh); rounded to 0.1 to keep source tidy.
  function toVw(px){ return Math.round(px / window.innerWidth * 1000) / 10; }
  function toVh(px){ return Math.round(px / window.innerHeight * 1000) / 10; }
  function readStyles(el){
    var cs = getComputedStyle(el);
    var off = translatePx(el);
    // Full background for the free-text field: a gradient/image shows up in
    // backgroundImage; otherwise fall back to the solid colour as a hex.
    var bgImg = cs.backgroundImage;
    var bgCss = (bgImg && bgImg !== 'none') ? bgImg : hex(cs.backgroundColor);
    // Image-frame variables (tint / crop position / zoom). Read the computed
    // custom props so the panel sliders start from the current value.
    function fnum(name, def){ var v = parseFloat(cs.getPropertyValue(name)); return isNaN(v) ? def : v; }
    var opStr = (cs.getPropertyValue('--obj-pos') || '').trim();
    var opM = opStr.match(/(-?\\d+(?:\\.\\d+)?)\\s*%?\\s+(-?\\d+(?:\\.\\d+)?)\\s*%?/);
    return {
      'font-size': parseFloat(cs.fontSize) || '',
      'color': hex(cs.color),
      'background-color': hex(cs.backgroundColor),
      'bg-css': bgCss,
      'font-weight': (parseInt(cs.fontWeight,10) >= 600) ? 'bold' : 'normal',
      'text-align': cs.textAlign,
      'padding': parseFloat(cs.paddingTop) || 0,
      'width': el.style.width || '',
      'height': el.style.height || '',
      'opacity': Math.round((parseFloat(cs.opacity) || 1) * 100),
      'border-radius': parseFloat(cs.borderTopLeftRadius) || 0,
      'tint': fnum('--tint', 0),
      'tint-color': (cs.getPropertyValue('--tint-color') || '').trim() || '#16432e',
      'imgop': fnum('--img-opacity', 1),
      'objx': opM ? parseFloat(opM[1]) : 50,
      'objy': opM ? parseFloat(opM[2]) : 50,
      'objs': fnum('--obj-scale', 1),
      'tx': toVw(off.x),
      'ty': toVh(off.y)
    };
  }
  // Chain of selectable ancestors (root first, clicked element last) so the
  // parent can show a breadcrumb to reach containers you can't click directly
  // (e.g. the slide wrapper or <body> that owns the page background).
  function ancestorPath(el){
    var path = [], p = el;
    while (p && p.dataset && p.dataset.ed != null){
      path.unshift({ ed: parseInt(p.dataset.ed,10), tag: p.tagName.toLowerCase() });
      p = p.parentElement ? p.parentElement.closest('[data-ed]') : null;
    }
    return path;
  }
  function select(el){
    clearSelected();
    selected = el;
    el.style.outline = '2px solid #38bdf8';
    el.style.outlineOffset = '1px';
    el.style.cursor = 'move';
    // Native bottom-right grabber for resize (needs a non-visible overflow).
    // Skip on html/body: forcing overflow:hidden there clips the page and kills
    // scrolling, and you never resize the page itself — you only recolour it.
    var tag = el.tagName.toLowerCase();
    if (tag !== 'html' && tag !== 'body'){
      el.style.resize = 'both';
      if (getComputedStyle(el).overflow === 'visible') el.style.overflow = 'hidden';
    }
    // Text is editable only for leaf elements (no child ELEMENTS) so we never
    // clobber nested markup when writing the text back to source.
    var editable = el.children.length === 0;
    var isDuo = !!(el.classList && el.classList.contains('duo'));
    var isFrame = isDuo || tag === 'img' || !!el.querySelector(':scope > img');
    parent.postMessage({ type:'cm-select', ed: parseInt(el.dataset.ed,10),
      line: parseInt(el.dataset.cmLine,10), tag: tag, path: ancestorPath(el),
      styles: readStyles(el), text: editable ? el.textContent : '', editable: editable,
      isDuo: isDuo, isFrame: isFrame }, '*');
  }
  window.addEventListener('message', function(e){
    var d = e.data || {};
    if (d.type === 'cm-mode-set'){ mode = d.mode; clearHover(); if (mode!=='visual') clearSelected(); if (mode!=='ai'){ removeMarquee(); clearAiOutlines(); } }
    else if (d.type === 'cm-ai-clear'){ clearAiOutlines(); }
    else if (d.type === 'cm-ai-busy-start'){ startAiBusy(); }
    else if (d.type === 'cm-ai-busy-end'){ stopAiBusy(); }
    else if (d.type === 'cm-style-apply'){
      var el = document.querySelector('[data-ed="'+d.ed+'"]');
      if (el){ if (d.value==='') el.style.removeProperty(d.prop); else el.style.setProperty(d.prop, d.value); }
    }
    else if (d.type === 'cm-text-apply'){
      var el2 = document.querySelector('[data-ed="'+d.ed+'"]');
      if (el2) el2.textContent = d.text;
    }
    else if (d.type === 'cm-select-ed'){   // breadcrumb / parent click
      var el3 = document.querySelector('[data-ed="'+d.ed+'"]');
      if (el3) select(el3);
    }
    else if (d.type === 'cm-deselect'){ clearSelected(); }
  });
  // Image-frame helpers: inside a photo frame, dragging PANS the photo and the
  // wheel ZOOMS it (writing --obj-pos / --obj-scale on the frame) instead of
  // moving the box — Canva-style "adjust within frame".
  var pan = null;
  function isImageFrame(el){
    if (!el) return false;
    if (el.classList && el.classList.contains('duo')) return true;
    if (el.tagName === 'IMG') return true;
    return !!(el.querySelector && el.querySelector(':scope > img'));
  }
  function parseObjPos(el){
    var s = (getComputedStyle(el).getPropertyValue('--obj-pos') || '').trim();
    var m = s.match(/(-?\\d+(?:\\.\\d+)?)\\s*%?\\s+(-?\\d+(?:\\.\\d+)?)\\s*%?/);
    return { x: m ? parseFloat(m[1]) : 50, y: m ? parseFloat(m[2]) : 50 };
  }
  // Clicking/dragging a filled photo should target its FRAME (where --tint /
  // --tint-color / --obj-pos / --obj-scale live), not the bare <img> — so every
  // image control applies consistently.
  function targetForVisual(el){
    if (el && el.tagName === 'IMG' && el.parentElement && el.parentElement.dataset && el.parentElement.dataset.ed != null
        && (el.getAttribute('data-fill') === '1' || (el.parentElement.classList && el.parentElement.classList.contains('duo')))) return el.parentElement;
    return el;
  }
  // ---- AI edit mode: rubber-band a marquee over one or more elements, then
  // send the common-ancestor fragment to the model with an instruction. ----
  var aibox = null;          // {sx,sy,el} while rubber-banding, else null
  var aiOutlined = [];       // elements currently purple-outlined as the region
  var aiSparkles = [];       // floating ✨ overlays placed at element corners
  var aiBusyTick = null;     // rAF id that keeps sparkle positions glued to elements
  function placeSparkles(){
    for (var i=0;i<aiSparkles.length;i++){
      var s = aiSparkles[i];
      if (!s.el || !s.anchor || !s.anchor.isConnected) continue;
      var r = s.anchor.getBoundingClientRect();
      s.el.style.left   = r.left + 'px';
      s.el.style.top    = r.top  + 'px';
      s.el.style.width  = r.width  + 'px';
      s.el.style.height = r.height + 'px';
    }
  }
  function startAiBusy(){
    stopAiBusy();
    if (!aiOutlined.length) return;
    aiOutlined.forEach(function(m){
      // Translucent blurred box overlay matching the element bounds, with a
      // conic gradient revolving around its perimeter as a "thinking" marker.
      var box = document.createElement('div');
      box.className = 'cm-ai-box';
      document.body.appendChild(box);
      aiSparkles.push({ el: box, anchor: m });
    });
    placeSparkles();
    function tick(){ placeSparkles(); aiBusyTick = requestAnimationFrame(tick); }
    aiBusyTick = requestAnimationFrame(tick);
  }
  function stopAiBusy(){
    if (aiBusyTick){ cancelAnimationFrame(aiBusyTick); aiBusyTick = null; }
    aiSparkles.forEach(function(s){ if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el); });
    aiSparkles = [];
  }
  function clearAiOutlines(){ stopAiBusy(); aiOutlined.forEach(function(m){ m.style.outline=''; m.style.outlineOffset=''; }); aiOutlined = []; }
  function createMarquee(x,y){
    aibox = { sx:x, sy:y };
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;z-index:2147483647;border:1.5px dashed #c084fc;background:rgba(192,132,252,0.12);pointer-events:none;left:'+x+'px;top:'+y+'px;width:0;height:0;';
    document.body.appendChild(d); aibox.el = d;
  }
  function updateMarquee(e){
    if (!aibox) return;
    var x1 = Math.min(aibox.sx, e.clientX), y1 = Math.min(aibox.sy, e.clientY);
    aibox.el.style.left = x1+'px'; aibox.el.style.top = y1+'px';
    aibox.el.style.width = Math.abs(e.clientX-aibox.sx)+'px';
    aibox.el.style.height = Math.abs(e.clientY-aibox.sy)+'px';
  }
  function removeMarquee(){ if (aibox && aibox.el && aibox.el.parentNode) aibox.el.parentNode.removeChild(aibox.el); aibox = null; }
  function overlapRatio(r, b){
    var ox = Math.max(0, Math.min(r.right,b.right) - Math.max(r.left,b.left));
    var oy = Math.max(0, Math.min(r.bottom,b.bottom) - Math.max(r.top,b.top));
    return (ox*oy) / ((r.width*r.height) || 1);
  }
  // Deepest [data-ed] element present in EVERY matched element's ancestor path —
  // the smallest single element whose source range covers the whole selection.
  function commonAncestorEd(els){
    var paths = els.map(function(el){ return ancestorPath(el).map(function(p){ return p.ed; }); });
    if (!paths.length || !paths[0].length) return 0;
    var first = paths[0], best = first[0];
    for (var i=0;i<first.length;i++){
      var ed = first[i];
      var inAll = paths.every(function(p){ return p[i] === ed; });
      if (inAll) best = ed; else break;
    }
    return best;
  }
  function finishMarquee(e){
    var box = aibox; removeMarquee();
    suppressClick = true;
    var x1 = Math.min(box.sx, e.clientX), y1 = Math.min(box.sy, e.clientY);
    var x2 = Math.max(box.sx, e.clientX), y2 = Math.max(box.sy, e.clientY);
    var matched = [];
    if (x2-x1 < 6 && y2-y1 < 6){           // a click, not a drag -> single element
      var one = document.elementFromPoint(e.clientX, e.clientY);
      one = one && one.closest ? one.closest('[data-ed]') : null;
      if (one) matched = [one];
    } else {
      var bb = { left:x1, top:y1, right:x2, bottom:y2 };
      var all = document.querySelectorAll('[data-ed]');
      for (var i=0;i<all.length;i++){
        var tg = all[i].tagName.toLowerCase();
        if (tg==='html' || tg==='body') continue;   // page root is never the region
        var r = all[i].getBoundingClientRect();
        if (r.width===0 || r.height===0) continue;
        var cx=(r.left+r.right)/2, cy=(r.top+r.bottom)/2;
        var centerIn = cx>=x1 && cx<=x2 && cy>=y1 && cy<=y2;
        if (centerIn || overlapRatio(r, bb) >= 0.6) matched.push(all[i]);
      }
    }
    if (!matched.length){ parent.postMessage({ type:'cm-toast', msg:'Drag over one or more elements', kind:'error' }, '*'); return; }
    var anc = commonAncestorEd(matched);
    var ancEl = document.querySelector('[data-ed="'+anc+'"]');
    var ancTag = ancEl ? ancEl.tagName.toLowerCase() : '';
    if (ancTag === 'html' || ancTag === 'body' || !ancEl){
      parent.postMessage({ type:'cm-toast', msg:'Selection spans the whole page — box a tighter area', kind:'error' }, '*');
      return;
    }
    clearAiOutlines();
    matched.forEach(function(m){ m.style.outline='2px solid #c084fc'; m.style.outlineOffset='1px'; aiOutlined.push(m); });
    parent.postMessage({ type:'cm-ai-region', ancestorEd: anc,
      eds: matched.map(function(m){ return parseInt(m.dataset.ed,10); }), count: matched.length }, '*');
  }
  // Drag the SELECTED box to reposition it (visual mode). We nudge via
  // transform: translate() so the flex/grid layout of siblings is untouched.
  // The bottom-right corner is reserved for the native resize grabber.
  document.addEventListener('mousedown', function(e){
    if (mode === 'ai'){
      if (e.button !== 0) return;
      clearAiOutlines(); createMarquee(e.clientX, e.clientY);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    suppressClick = false;
    if (mode !== 'visual' || !selected) return;
    var el = e.target && e.target.closest && e.target.closest('[data-ed]');
    el = targetForVisual(el);
    if (el === selected){
      var r = selected.getBoundingClientRect();
      if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18){
        resizing = true;
        rz = { sx:e.clientX, sy:e.clientY, w0:selected.offsetWidth, h0:selected.offsetHeight, img:(selected.tagName === 'IMG') };
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    if (!el || el !== selected) return;   // only the already-selected box drags
    e.preventDefault(); e.stopPropagation();
    if (isImageFrame(selected)){
      var op = parseObjPos(selected); var rr = selected.getBoundingClientRect();
      pan = { sx:e.clientX, sy:e.clientY, x0:op.x, y0:op.y, w:rr.width||1, h:rr.height||1, cx:op.x, cy:op.y, moved:false };
    } else {
      var off = translatePx(selected);
      drag = { sx:e.clientX, sy:e.clientY, bx:off.x, by:off.y, moved:false };
    }
  }, true);
  // rAF-throttle the live drag/resize readout to the parent: the element's own
  // transform updates every mousemove (smooth in here), but the parent only
  // needs ~1 update/frame for its X/Y/size fields — posting every pixel made
  // the parent re-render too often and felt janky.
  var movePend = false, lastMove = null;
  function postMove(msg){ lastMove = msg; if (movePend) return; movePend = true; requestAnimationFrame(function(){ movePend = false; if (lastMove) parent.postMessage(lastMove, '*'); }); }
  document.addEventListener('mousemove', function(e){
    if (aibox){ e.preventDefault(); updateMarquee(e); return; }
    if (resizing && selected && rz){
      // Manual resize (delta from start) so it works on <img> too — CSS
      // resize:both has no effect on replaced elements. Images keep aspect.
      var nw = Math.max(8, rz.w0 + (e.clientX - rz.sx));
      var nh = rz.img ? Math.max(8, nw / (rz.w0 / rz.h0)) : Math.max(8, rz.h0 + (e.clientY - rz.sy));
      selected.style.width = nw + 'px';
      selected.style.height = nh + 'px';
      postMove({ type:'cm-resize-move', w: toVw(nw)+'vw', h: toVh(nh)+'vh' });
      return;
    }
    if (pan && selected){
      e.preventDefault();
      var px = Math.max(0, Math.min(100, pan.x0 - (e.clientX - pan.sx) / pan.w * 100));
      var py = Math.max(0, Math.min(100, pan.y0 - (e.clientY - pan.sy) / pan.h * 100));
      if (Math.abs(e.clientX-pan.sx) > 2 || Math.abs(e.clientY-pan.sy) > 2) pan.moved = true;
      pan.cx = px; pan.cy = py;
      selected.style.setProperty('--obj-pos', px.toFixed(1)+'% '+py.toFixed(1)+'%');
      return;
    }
    if (!drag) return;
    e.preventDefault();
    var nx = drag.bx + (e.clientX - drag.sx), ny = drag.by + (e.clientY - drag.sy);
    if (Math.abs(e.clientX-drag.sx) > 2 || Math.abs(e.clientY-drag.sy) > 2) drag.moved = true;
    selected.style.transform = 'translate(' + nx + 'px, ' + ny + 'px)';
    postMove({ type:'cm-drag-move', tx: toVw(nx), ty: toVh(ny) });
  }, true);
  document.addEventListener('mouseup', function(e){
    if (aibox){ e.preventDefault(); e.stopPropagation(); finishMarquee(e); return; }
    if (resizing){
      resizing = false; rz = null;
      if (selected){
        var w = toVw(selected.offsetWidth)+'vw', h = toVh(selected.offsetHeight)+'vh';
        parent.postMessage({ type:'cm-resize-end', ed: parseInt(selected.dataset.ed,10), w: w, h: h }, '*');
      }
      return;
    }
    if (pan){
      var pmoved = pan.moved, P = pan; pan = null;
      if (!pmoved) return;
      e.preventDefault(); e.stopPropagation(); suppressClick = true;
      if (selected) parent.postMessage({ type:'cm-var-set', ed: parseInt(selected.dataset.ed,10), prop:'--obj-pos', value: P.cx.toFixed(1)+'% '+P.cy.toFixed(1)+'%' }, '*');
      return;
    }
    if (!drag) return;
    var moved = drag.moved; drag = null;
    if (!moved) return;                    // a plain click, not a drag
    e.preventDefault(); e.stopPropagation();
    suppressClick = true;
    var off = translatePx(selected);
    var vx = toVw(off.x), vy = toVh(off.y);
    var value = (vx===0 && vy===0) ? '' : 'translate(' + vx + 'vw, ' + vy + 'vh)';
    if (value==='') selected.style.removeProperty('transform'); else selected.style.transform = value;
    parent.postMessage({ type:'cm-drag-end', ed: parseInt(selected.dataset.ed,10), value: value, tx: vx, ty: vy }, '*');
  }, true);
  // Wheel over a selected image frame = zoom the photo (--obj-scale), committed
  // to source shortly after the user stops scrolling.
  var wheelT = null;
  document.addEventListener('wheel', function(e){
    if (mode !== 'visual' || !selected || !isImageFrame(selected)) return;
    e.preventDefault();
    var cur = parseFloat(getComputedStyle(selected).getPropertyValue('--obj-scale')) || 1;
    var ns = Math.max(1, Math.min(4, cur + (e.deltaY < 0 ? 0.08 : -0.08)));
    selected.style.setProperty('--obj-scale', ns.toFixed(3));
    if (wheelT) clearTimeout(wheelT);
    wheelT = setTimeout(function(){ if (selected) parent.postMessage({ type:'cm-var-set', ed: parseInt(selected.dataset.ed,10), prop:'--obj-scale', value: ns.toFixed(3) }, '*'); }, 220);
  }, { passive:false, capture:true });
  document.addEventListener('click', function(e){
    if (suppressClick){ suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (mode === 'off') return;
    var el = e.target && e.target.closest && e.target.closest('[data-ed]');
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    if (mode === 'inspect') parent.postMessage({ type:'cm-jump', line: parseInt(el.dataset.cmLine,10) }, '*');
    else if (mode === 'visual') select(targetForVisual(el));
  }, true);
  document.addEventListener('mouseover', function(e){
    if (mode === 'off' || drag || resizing || pan || aibox) return;
    var el = e.target && e.target.closest && e.target.closest('[data-ed]');
    el = targetForVisual(el);
    if (el === hovered) return;
    clearHover();
    if (el && el !== selected){
      el.style.outline = '2px dashed #fbbf24'; el.style.outlineOffset = '2px';
      el.style.cursor = (mode==='visual') ? 'pointer' : 'crosshair'; hovered = el;
    }
  }, true);
  document.addEventListener('mouseleave', clearHover, true);
  // Keyboard (visual mode): arrow keys nudge the selected box (Shift = bigger
  // step); Ctrl/Cmd+C copies it; Ctrl/Cmd+V pastes after the clicked box.
  var ARROWS = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
  document.addEventListener('keydown', function(e){
    if (mode !== 'visual') return;
    if (selected && ARROWS[e.key]){
      e.preventDefault();
      var a = ARROWS[e.key], step = e.shiftKey ? 20 : 4, o = translatePx(selected);
      var vx = toVw(o.x + a[0]*step), vy = toVh(o.y + a[1]*step);
      var val = (vx===0 && vy===0) ? '' : 'translate(' + vx + 'vw, ' + vy + 'vh)';
      if (val==='') selected.style.removeProperty('transform'); else selected.style.transform = val;
      parent.postMessage({ type:'cm-drag-end', ed: parseInt(selected.dataset.ed,10), value: val, tx: vx, ty: vy }, '*');
      return;
    }
    // Delete / Backspace removes the selected element (unless typing in a field).
    if (selected && (e.key === 'Delete' || e.key === 'Backspace')){
      var tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      e.preventDefault();
      parent.postMessage({ type:'cm-delete', ed: parseInt(selected.dataset.ed,10) }, '*');
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'c' && selected){
      e.preventDefault();
      parent.postMessage({ type:'cm-copy', ed: parseInt(selected.dataset.ed,10) }, '*');
    } else if (k === 'v'){
      e.preventDefault();
      parent.postMessage({ type:'cm-paste', ed: selected ? parseInt(selected.dataset.ed,10) : -1 }, '*');
    }
  }, true);
  // Report which slide is in view (throttled) so the parent can re-inject it on
  // the next reload. Slide decks scroll a snap container, not window, so we track
  // the .slide nearest the top rather than a scrollY.
  function scrollState(){
    var sl = document.querySelectorAll('.slide');
    if (sl.length){
      var best = 0, bd = Infinity;
      for (var i=0;i<sl.length;i++){ var dd = Math.abs(sl[i].getBoundingClientRect().top); if (dd < bd){ bd = dd; best = i; } }
      return { slide: best };
    }
    var se = document.scrollingElement || document.documentElement;
    return { top: se ? se.scrollTop : 0 };
  }
  var scrollPend = false;
  document.addEventListener('scroll', function(){
    if (scrollPend) return; scrollPend = true;
    requestAnimationFrame(function(){ scrollPend = false; var st = scrollState(); st.type = 'cm-scroll'; parent.postMessage(st, '*'); });
  }, true);
  // ---- Canva-style: drag an image FILE from the OS onto a frame to fill it ----
  // The dropped image becomes a child <img object-fit:cover> inside the frame, so
  // it crops to the frame's shape (border-radius / size). Only in Visual mode.
  var dropFrame = null;
  function clearDropFrame(){ if (dropFrame){ dropFrame.style.outline=''; dropFrame.style.outlineOffset=''; dropFrame=null; } }
  // Prefer a .duo image-frame ancestor (template frames) over an inner child;
  // otherwise the nearest editable box under the cursor.
  function resolveFrame(t){
    if (!t || !t.closest) return null;
    var duo = t.closest('.duo');
    if (duo && duo.dataset && duo.dataset.ed != null) return duo;
    return t.closest('[data-ed]');
  }
  function dragHasFiles(e){
    var dt = e.dataTransfer; if (!dt || !dt.types) return false;
    for (var i=0;i<dt.types.length;i++){ if (dt.types[i]==='Files') return true; }
    return false;
  }
  document.addEventListener('dragenter', function(e){ if (dragHasFiles(e)){ e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('dragover', function(e){
    if (!dragHasFiles(e)) return;             // works in any mode; only for file drags
    e.preventDefault(); e.stopPropagation();  // allow drop + stop the browser opening the file
    try { e.dataTransfer.dropEffect='copy'; } catch(_){}
    var fr = resolveFrame(e.target);
    if (fr!==dropFrame){ clearDropFrame(); if (fr){ fr.style.outline='3px solid #5fd35f'; fr.style.outlineOffset='-3px'; dropFrame=fr; } }
  }, true);
  document.addEventListener('dragleave', function(e){ if (!e.relatedTarget) clearDropFrame(); }, true);
  document.addEventListener('drop', function(e){
    if (!dragHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    var fr = resolveFrame(e.target); clearDropFrame();
    if (!fr){ parent.postMessage({ type:'cm-toast', msg:'Drop the image onto a frame', kind:'error' }, '*'); return; }
    var f = (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) ? e.dataTransfer.files[0] : null;
    if (!f || !/^image\\//.test(f.type)){ parent.postMessage({ type:'cm-toast', msg:'Only image files can be dropped', kind:'error' }, '*'); return; }
    var cs = getComputedStyle(fr);
    parent.postMessage({ type:'cm-fill-image', ed:parseInt(fr.dataset.ed,10), file:f,
      isImg:(fr.tagName==='IMG'), relative:(cs.position==='static'), clip:(cs.overflow==='visible'),
      boxH: fr.getBoundingClientRect().height }, '*');
  }, true);
  // Restore the slide that was in view before this reload (parent injected it).
  (function(){
    var r = window.__cmRestore;
    if (!r) return;
    if (typeof r.slide === 'number'){
      var sl = document.querySelectorAll('.slide');
      if (sl[r.slide]) sl[r.slide].scrollIntoView({ block:'start' });
    } else if (typeof r.top === 'number'){
      var se = document.scrollingElement || document.documentElement;
      if (se) se.scrollTop = r.top;
    }
  })();
})();
</script>`;

function buildPreviewHtml(html: string, restore?: { slide?: number; top?: number } | null, mode?: string): string {
  const marked = injectLineMarkers(html);
  // Seed the in-iframe script with the current mode + the slide to restore, so a
  // reload keeps Visual mode and the same slide (set before the script runs → no
  // jump to the first slide, no postMessage race).
  const globals = `<script>window.__cmMode=${JSON.stringify(mode || "inspect")};window.__cmRestore=${restore ? JSON.stringify(restore) : "null"};</script>`;
  const inject = globals + INSPECT_SCRIPT;
  // Append just before </body>; fallback append at end.
  if (/<\/body>/i.test(marked)) return marked.replace(/<\/body>/i, inject + "</body>");
  return marked + inject;
}

interface Props {
  taskId: string;
  file: FileInfo;
  onClose: () => void;
  onSaved: (info: FileInfo) => void;
}

export function FileEditorModal({ taskId, file, onClose, onSaved }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Hidden file input for "Add image" (pick from machine, embedded as data URL).
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageAnchorRef = useRef<number | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [current, setCurrent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // Preview interaction mode: 'inspect' = click jumps to code line, 'visual' =
  // click opens the property panel to edit styles, 'off' = preview interactive.
  const [mode, setMode] = useState<"inspect" | "visual" | "off" | "ai">("inspect");
  const [selectedEd, setSelectedEd] = useState<number | null>(null);
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [selPath, setSelPath] = useState<{ ed: number; tag: string }[]>([]);
  const [selStyles, setSelStyles] = useState<Record<string, string | number>>({});
  const [selText, setSelText] = useState<string>("");
  const [selEditable, setSelEditable] = useState<boolean>(false);
  const [selIsFrame, setSelIsFrame] = useState<boolean>(false);
  // Format painter: after "Copy format" the painter is ARMED — the next element
  // the user clicks gets the copied appearance (typography + colour) applied,
  // then it disarms. formatArmedRef mirrors the state for the (stable) message
  // handler closure.
  const formatRef = useRef<Record<string, string> | null>(null);
  const formatArmedRef = useRef(false);
  const [formatArmed, setFormatArmed] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewWidthPct, setPreviewWidthPct] = useState(50);
  const [dragging, setDragging] = useState(false);
  // AI edit mode: a marquee region in the preview maps to one common-ancestor
  // element (aiRegion.ancestorEd). On apply we send that element's source
  // fragment + the instruction to the model and splice the result back.
  const [aiRegion, setAiRegion] = useState<{ ancestorEd: number; count: number } | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  // Elapsed-seconds counter shown under the Editing button. Resets on each run.
  const [aiElapsed, setAiElapsed] = useState(0);
  useEffect(() => {
    if (!aiBusy) { setAiElapsed(0); return; }
    setAiElapsed(0);
    const start = Date.now();
    const id = window.setInterval(() => {
      setAiElapsed(Math.floor((Date.now() - start) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [aiBusy]);
  // When true, the next debounced preview tick skips the iframe reload — a
  // visual-edit change was already applied live via postMessage, so reloading
  // would only flicker and drop the current selection.
  const visualEditRef = useRef(false);
  // Last preview scroll position reported by the iframe (slide index, or a raw
  // scrollTop fallback). Slide decks scroll a snap container — not window — so
  // we restore the visible slide after a reload instead of a window scrollY.
  const lastScrollRef = useRef<{ slide?: number; top?: number } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const supportsPreview = ext === "html" || ext === "htm" || ext === "svg" || ext === "md";
  const supportsInspect = ext === "html" || ext === "htm" || ext === "svg";
  const dirty = current !== original;
  const href = `/api/files/${taskId}/${file.name.split("/").map(encodeURIComponent).join("/")}`;

  // Pre-spawn the AI-edit subprocess as soon as the editor opens an HTML/SVG
  // file. Users typically AI-edit slides; warming on file-open (not on AI mode
  // toggle) covers the case where they enter AI mode and immediately submit,
  // so even the first edit skips the ~5-9s cold spawn. Fire-and-forget; the
  // warm session sits idle ~10min if unused.
  useEffect(() => {
    if (!supportsInspect) return;
    fetch("/api/files/ai-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warm: true }),
    }).catch(() => {});
  }, [supportsInspect]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) {
          setOriginal(text);
          setCurrent(text);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [href]);

  useEffect(() => {
    if (loading || error || !editorRef.current) return;
    const state = EditorState.create({
      doc: original,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        history(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        dracula,
        EditorView.lineWrapping,
        langFor(ext),
        EditorView.updateListener.of(u => {
          if (u.docChanged) setCurrent(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [loading, error, original, ext]);

  // Listen for messages from the preview iframe (Inspect jump + Visual select).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (d?.type === "cm-jump" && typeof d.line === "number") {
        const view = viewRef.current;
        if (!view) return;
        const totalLines = view.state.doc.lines;
        const ln = Math.max(1, Math.min(totalLines, d.line));
        const info = view.state.doc.line(ln);
        view.dispatch({
          selection: { anchor: info.from, head: info.from },
          effects: EditorView.scrollIntoView(info.from, { y: "center" }),
        });
        view.focus();
      } else if (d?.type === "cm-select" && typeof d.ed === "number") {
        setSelectedEd(d.ed);
        setSelectedTag(typeof d.tag === "string" ? d.tag : "");
        setSelPath(Array.isArray(d.path) ? d.path : []);
        setSelStyles(d.styles && typeof d.styles === "object" ? d.styles : {});
        setSelText(typeof d.text === "string" ? d.text : "");
        setSelEditable(!!d.editable);
        setSelIsFrame(!!d.isFrame);
        if (formatArmedRef.current && formatRef.current) {
          applyFormatTo(d.ed);
          formatArmedRef.current = false; setFormatArmed(false);
          toast("Format applied", "success");
        }
      } else if (d?.type === "cm-drag-move") {
        // Live readout while dragging; source is written only on drag end.
        setSelStyles(s => ({ ...s, tx: d.tx, ty: d.ty }));
      } else if (d?.type === "cm-resize-move") {
        setSelStyles(s => ({ ...s, width: d.w, height: d.h }));
      } else if (d?.type === "cm-drag-end" && typeof d.ed === "number") {
        // Commit transform to source (read latest from the doc, not a closure).
        const view = viewRef.current;
        const src = view ? view.state.doc.toString() : "";
        const next = setStyleProp(src, d.ed, "transform", d.value || "");
        visualEditRef.current = true;
        if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
        setSelStyles(s => ({ ...s, tx: d.tx, ty: d.ty }));
      } else if (d?.type === "cm-resize-end" && typeof d.ed === "number") {
        const view = viewRef.current;
        let src = view ? view.state.doc.toString() : "";
        src = setStyleProp(src, d.ed, "width", d.w);
        src = setStyleProp(src, d.ed, "height", d.h);
        visualEditRef.current = true;
        if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } });
        setSelStyles(s => ({ ...s, width: d.w, height: d.h }));
      } else if (d?.type === "cm-copy" && typeof d.ed === "number") {
        copyElement(d.ed);
      } else if (d?.type === "cm-paste") {
        if (typeof d.ed === "number" && d.ed >= 0) pasteElement(d.ed);
        else toast("Click a box first to choose where to paste", "error");
      } else if (d?.type === "cm-delete" && typeof d.ed === "number") {
        deleteElement(d.ed);
      } else if (d?.type === "cm-scroll") {
        lastScrollRef.current = { slide: d.slide, top: d.top };
      } else if (d?.type === "cm-fill-image" && typeof d.ed === "number" && d.file) {
        fillBoxWithImage(d.ed, d.file as File, { isImg: !!d.isImg, relative: !!d.relative, clip: !!d.clip, boxH: typeof d.boxH === "number" ? d.boxH : 0 });
      } else if (d?.type === "cm-toast" && typeof d.msg === "string") {
        toast(d.msg, d.kind === "error" ? "error" : "success");
      } else if (d?.type === "cm-ai-region" && typeof d.ancestorEd === "number") {
        setAiRegion({ ancestorEd: d.ancestorEd, count: typeof d.count === "number" ? d.count : 1 });
      } else if (d?.type === "cm-var-set" && typeof d.ed === "number" && typeof d.prop === "string") {
        // Commit a CSS var (crop / zoom from dragging) to source without a reload
        // — the iframe already shows it live.
        const view = viewRef.current;
        const srcNow = view ? view.state.doc.toString() : "";
        const next = setStyleProp(srcNow, d.ed, d.prop, String(d.value ?? ""));
        visualEditRef.current = true;
        if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // copyElement/pasteElement are stable (useCallback) so capturing once is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tell the iframe the interaction mode (without reloading). Also clears the
  // current selection whenever the mode changes OR the preview reloads (a fresh
  // iframe lost the highlight + the data-ed indices may have shifted), so the
  // panel can't write to a stale element — the user just re-clicks.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "cm-mode-set", mode }, "*");
    setSelectedEd(null);
    setSelPath([]);
  }, [mode, previewKey]);

  // Switching modes discards any pending AI region + prompt (the marquee + its
  // outlines live in the iframe and are cleared there on cm-mode-set).
  useEffect(() => {
    setAiRegion(null);
    setAiPrompt("");
  }, [mode]);

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(href, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOriginal(current);
      onSaved(data as FileInfo);
      toast("Saved", "success");
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, "error");
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, href, current, onSaved]);

  const exportPptx = useCallback(async (mode: "image" | "native") => {
    if (exporting) return;
    setExportMenu(false);
    setExporting(true);
    try {
      const base = file.name.replace(/\.html?$/i, "");
      const res = await fetch("/api/html-to-pptx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          html: current,
          mode,
          filename: base + (mode === "native" ? "-editable.pptx" : ".pptx"),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const extra = mode === "native" ? `, ${data.fonts_embedded || 0} font nhúng` : "";
      toast(`Exported ${data.file.name} (${data.n_slides} slides${extra}) to the Files panel`, "success");
    } catch (e) {
      toast(`Export PPTX failed: ${(e as Error).message}`, "error");
    } finally {
      setExporting(false);
    }
  }, [exporting, taskId, current, file.name]);

  const revert = useCallback(async () => {
    if (!dirty) return;
    if (!(await appConfirm("Discard all unsaved changes?"))) return;
    setCurrent(original);
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: original },
      });
    }
    // Force the preview back to the original (clear any pending visual-edit
    // skip-flag + selection so the iframe actually reloads to the clean state).
    visualEditRef.current = false;
    setSelectedEd(null);
    iframeRef.current?.contentWindow?.postMessage({ type: "cm-deselect" }, "*");
    setPreviewKey(k => k + 1);
  }, [dirty, original]);

  const handleClose = useCallback(async () => {
    if (dirty && !(await appConfirm("You have unsaved changes. Close anyway?"))) return;
    onClose();
  }, [dirty, onClose]);

  // CSS fullscreen. The modal is portaled to <body>, so expanding it to the
  // full viewport works WITHOUT the Fullscreen API — the real Fullscreen API
  // dropped out whenever the OS file picker or a confirm dialog opened.
  const toggleFullscreen = useCallback(() => setFullscreen(v => !v), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // When CodeMirror is focused it owns Ctrl+Z/Y; only step in when focus is
      // elsewhere (Visual mode hides the code pane, so its keymap never fires).
      const inCM = !!editorRef.current && editorRef.current.contains(document.activeElement);
      if (mod && k === "s") {
        e.preventDefault();
        void save();
      } else if (mod && k === "z" && !e.shiftKey) {
        if (inCM) return;
        e.preventDefault();
        const v = viewRef.current; if (v) undo(v);
      } else if (mod && ((k === "z" && e.shiftKey) || k === "y")) {
        if (inCM) return;
        e.preventDefault();
        const v = viewRef.current; if (v) redo(v);
      } else if (e.key === "Escape") {
        // In fullscreen, Esc exits fullscreen first; otherwise it closes.
        if (fullscreen) { setFullscreen(false); return; }
        void handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, handleClose, fullscreen]);

  // Debounced preview refresh. Visual-edit changes already applied live in the
  // iframe via postMessage, so skip the reload (which would flicker + drop the
  // selection) for those — code-typed changes still trigger a normal reload.
  useEffect(() => {
    if (!supportsPreview || !showPreview) return;
    if (visualEditRef.current) { visualEditRef.current = false; return; }
    // The slide in view is re-injected on reload (lastScrollRef), so undo/redo
    // and code typing don't bounce the preview back to the first slide.
    const t = setTimeout(() => setPreviewKey(k => k + 1), 600);
    return () => clearTimeout(t);
  }, [current, supportsPreview, showPreview]);

  // Apply a single CSS property change from the Visual panel: live-update the
  // iframe element, write the merged inline style back into the source, mirror
  // it into CodeMirror, and update the panel's local value.
  const applyStyle = useCallback((prop: string, cssValue: string, panelValue: string | number) => {
    if (selectedEd == null) return;
    // Live update in the preview (no reload).
    iframeRef.current?.contentWindow?.postMessage(
      { type: "cm-style-apply", ed: selectedEd, prop, value: cssValue }, "*");
    // Write the merged inline style back into source. Read latest from the
    // CodeMirror doc (single source of truth) to avoid stale-closure issues.
    const view = viewRef.current;
    const src = view ? view.state.doc.toString() : current;
    const next = setStyleProp(src, selectedEd, prop, cssValue);
    visualEditRef.current = true;
    if (view) {
      // Dispatching fires the updateListener which calls setCurrent(next).
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    } else {
      setCurrent(next);
    }
    setSelStyles(s => ({ ...s, [prop]: panelValue }));
  }, [selectedEd, current]);

  // Send the boxed region's source fragment + instruction to the model, then
  // splice the edited fragment back over the same char range. The debounced
  // preview refresh reloads the iframe afterwards (data-ed indices shifted).
  const sendAiEdit = useCallback(async () => {
    if (!aiRegion || !aiPrompt.trim() || aiBusy) return;
    const view = viewRef.current;
    const src = view ? view.state.doc.toString() : current;
    const range = elementOuterRange(src, aiRegion.ancestorEd);
    if (!range) { toast("Couldn't locate the selected region — re-select it", "error"); return; }
    const snippet = src.slice(range[0], range[1]);
    setAiBusy(true);
    iframeRef.current?.contentWindow?.postMessage({ type: "cm-ai-busy-start" }, "*");
    try {
      const res = await fetch("/api/files/ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snippet, instruction: aiPrompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const edited = String(data.html || "");
      if (!edited) throw new Error("Empty edit");
      const next = src.slice(0, range[0]) + edited + src.slice(range[1]);
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      else setCurrent(next);
      setAiRegion(null);
      setAiPrompt("");
      iframeRef.current?.contentWindow?.postMessage({ type: "cm-ai-clear" }, "*");
      toast("AI edit applied", "success");
    } catch (e) {
      toast(`AI edit failed: ${(e as Error).message}`, "error");
    } finally {
      iframeRef.current?.contentWindow?.postMessage({ type: "cm-ai-busy-end" }, "*");
      setAiBusy(false);
    }
  }, [aiRegion, aiPrompt, aiBusy, current]);

  // Live-only preview update (postMessage to the iframe, NO source write). Used
  // by free-text fields (the background CSS box) while typing — source is
  // committed on blur so a half-typed gradient never lands in the file.
  const livePreview = useCallback((prop: string, cssValue: string) => {
    if (selectedEd == null) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "cm-style-apply", ed: selectedEd, prop, value: cssValue }, "*");
  }, [selectedEd]);

  // Select an ancestor (breadcrumb / parent button): ask the iframe to select
  // that data-ed element, which echoes back a fresh cm-select with its styles.
  const selectPath = useCallback((ed: number) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "cm-select-ed", ed }, "*");
  }, []);

  const applyText = useCallback((text: string) => {
    if (selectedEd == null) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "cm-text-apply", ed: selectedEd, text }, "*");
    const view = viewRef.current;
    const src = view ? view.state.doc.toString() : current;
    const next = setTextContent(src, selectedEd, text);
    visualEditRef.current = true;
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    else setCurrent(next);
    setSelText(text);
  }, [selectedEd, current]);

  // Format painter. Reads computed appearance (typography + colour) via the
  // same-origin preview doc; applies to a target element (live + source),
  // leaving geometry/position untouched.
  const FORMAT_PROPS = ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration-line", "color"];
  const applyFormatTo = useCallback((ed: number) => {
    if (ed == null || !formatRef.current) return;
    const fmt = formatRef.current;
    const win = iframeRef.current?.contentWindow;
    for (const [p, v] of Object.entries(fmt)) win?.postMessage({ type: "cm-style-apply", ed, prop: p, value: v }, "*");
    const view = viewRef.current;
    let src = view ? view.state.doc.toString() : "";
    for (const [p, v] of Object.entries(fmt)) src = setStyleProp(src, ed, p, v);
    visualEditRef.current = true;
    if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } });
  }, []);
  // Toggle: if armed, disarm. Otherwise copy the selected element's format and
  // arm — the next clicked element auto-receives it (see cm-select handler).
  const toggleFormatPainter = useCallback(() => {
    if (formatArmedRef.current) { formatArmedRef.current = false; setFormatArmed(false); return; }
    if (selectedEd == null) { toast("Select an element first to copy its format", "error"); return; }
    const win = iframeRef.current?.contentWindow;
    const el = iframeRef.current?.contentDocument?.querySelector(`[data-ed="${selectedEd}"]`) as HTMLElement | null;
    if (!el || !win) { toast("Couldn't read this element's format", "error"); return; }
    const cs = win.getComputedStyle(el);
    const fmt: Record<string, string> = {};
    for (const p of FORMAT_PROPS) { const v = cs.getPropertyValue(p); if (v) fmt[p] = v; }
    formatRef.current = fmt;
    formatArmedRef.current = true; setFormatArmed(true);
    toast("Format copied — now click the element to apply it to", "success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEd]);

  // Clipboard holding one element's outer HTML for Ctrl+C / Ctrl+V.
  const clipboardRef = useRef<string | null>(null);

  // Insert an HTML block right after the element at targetEd (matching its
  // indentation). Structural change → reload preview (scroll kept) + clear
  // selection because data-ed indices shift. Reads the live CodeMirror doc so it
  // never goes stale — safe to call from the iframe message handler.
  const insertAfter = useCallback((targetEd: number, block: string, msg: string) => {
    const view = viewRef.current;
    if (!view) return;
    const src = view.state.doc.toString();
    const range = elementOuterRange(src, targetEd);
    if (!range) { toast("Couldn't locate the target element", "error"); return; }
    const [start, end] = range;
    const lineStart = src.lastIndexOf("\n", start - 1) + 1;
    const indent = src.slice(lineStart, start).match(/^\s*/)?.[0] ?? "";
    const next = src.slice(0, end) + "\n" + indent + block + src.slice(end);
    visualEditRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    setSelectedEd(null);
    iframeRef.current?.contentWindow?.postMessage({ type: "cm-deselect" }, "*");
    // lastScrollRef (updated live from the iframe) is re-injected on reload, so
    // the preview stays on the slide being edited rather than jumping to top.
    setPreviewKey(k => k + 1);
    toast(msg, "success");
  }, []);

  const copyElement = useCallback((ed: number) => {
    const view = viewRef.current;
    if (!view) return;
    const src = view.state.doc.toString();
    const range = elementOuterRange(src, ed);
    if (!range) { toast("Couldn't copy this element", "error"); return; }
    clipboardRef.current = src.slice(range[0], range[1]);
    toast("Copied — click a box and press Ctrl+V to paste", "success");
  }, []);

  const pasteElement = useCallback((targetEd: number) => {
    if (clipboardRef.current == null) { toast("Nothing copied yet — select a box and press Ctrl+C", "error"); return; }
    insertAfter(targetEd, clipboardRef.current, "Pasted — drag to reposition");
  }, [insertAfter]);

  // Canva-style "add element": insert a new absolute-positioned element into the
  // selected element's slide (after it, so it lands in the same .slide which is
  // position:relative), then the user drags it freely. Requires a selection so
  // we know which slide to drop into (same UX as paste).
  const addElement = useCallback((kind: "text" | "box" | "ellipse" | "line" | "image") => {
    if (selectedEd == null) { toast("Click a box on the target slide first", "error"); return; }
    if (kind === "image") {
      // Pick from the machine; the file is embedded as a data URL on select.
      imageAnchorRef.current = selectedEd;
      imageInputRef.current?.click();
      return;
    }
    let block = "";
    if (kind === "text") {
      block = `<div style="position: absolute; left: 8%; top: 8%; font-size: 28px; font-weight: 600;">Text mới</div>`;
    } else if (kind === "box") {
      block = `<div style="position: absolute; left: 8%; top: 8%; width: 24%; height: 14%; background: rgba(125,211,252,0.18); border: 1px solid rgba(125,211,252,0.5); border-radius: 12px;"></div>`;
    } else if (kind === "ellipse") {
      block = `<div style="position: absolute; left: 8%; top: 8%; width: 16%; height: 16%; background: rgba(125,211,252,0.18); border: 1px solid rgba(125,211,252,0.5); border-radius: 50%;"></div>`;
    } else {
      block = `<div style="position: absolute; left: 8%; top: 12%; width: 30%; height: 3px; background: currentColor; opacity: 0.5; border-radius: 2px;"></div>`;
    }
    insertAfter(selectedEd, block, "Added — click it then drag to reposition");
  }, [selectedEd, insertAfter]);

  // Read an image File, downscale to a sane width, and hand back a data URL so
  // the deck stays self-contained (works when exported / opened elsewhere).
  const readScaledDataUrl = useCallback((file: File, cb: (dataUrl: string) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new window.Image();
      img.onload = () => {
        const maxW = 1600;
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        let dataUrl = src;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0, w, h);
            dataUrl = canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.85);
          }
        } catch { /* tainted/decoding issue — fall back to original data URL */ }
        cb(dataUrl);
      };
      img.onerror = () => toast("Could not read that image", "error");
      img.src = src;
    };
    reader.onerror = () => toast("Could not read that file", "error");
    reader.readAsDataURL(file);
  }, []);

  // Read the selected frame's live box model from the (same-origin) preview
  // iframe so a fill knows: is it an <img>? does it need position:relative /
  // overflow:hidden? does it have a real height (→ crop to shape vs fit width)?
  const frameOptsFromIframe = useCallback((ed: number) => {
    try {
      const win = iframeRef.current?.contentWindow;
      const doc = iframeRef.current?.contentDocument;
      const el = doc?.querySelector(`[data-ed="${ed}"]`) as HTMLElement | null;
      if (!el || !win) return null;
      const cs = win.getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        isImg: el.tagName === "IMG",
        relative: cs.position === "static",
        clip: cs.overflow === "visible",
        boxH: el.getBoundingClientRect().height,
      };
    } catch { return null; }
  }, []);

  // Canva-style frame fill: put an image INTO a box and crop it to that box's
  // shape. If the target IS an <img>, swap its src. Otherwise place/replace a
  // child <img> that fills the box. A box with a real height → absolute
  // object-fit:cover (crops to the shape, respecting border-radius). A flat
  // placeholder with no height → a block image at full width (visible, keeps
  // aspect). `.duo` frames already carry the duotone overlay via CSS, so a
  // dropped photo auto-tints green.
  const fillBoxWithImage = useCallback(
    (ed: number, file: File, opts: { isImg: boolean; relative: boolean; clip: boolean; boxH?: number }) => {
      readScaledDataUrl(file, (dataUrl) => {
        const view = viewRef.current;
        if (!view) return;
        let src = view.state.doc.toString();
        const t0 = scanOpenTags(src)[ed];
        if (!t0) { toast("Couldn't find the frame", "error"); return; }
        if (t0.name.toLowerCase() === "img" || opts.isImg) {
          src = setTagAttr(src, ed, "src", dataUrl);
        } else {
          const sized = (opts.boxH ?? 0) >= 24;   // a real frame → crop to its shape
          if (sized && opts.relative) src = setStyleProp(src, ed, "position", "relative");
          if (sized && opts.clip) src = setStyleProp(src, ed, "overflow", "hidden");
          const range = elementOuterRange(src, ed);
          const t = scanOpenTags(src)[ed];
          if (!t) { toast("Couldn't find the frame", "error"); return; }
          const innerStart = t.end;
          const innerEnd = range ? range[1] : src.length;
          // Re-fill: replace the src of an existing dropped image rather than stack.
          const m = /<img\b[^>]*\bdata-fill="1"[^>]*>/i.exec(src.slice(innerStart, innerEnd));
          if (m) {
            const newTag = m[0].replace(/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `src="${dataUrl}"`);
            const abs = innerStart + m.index;
            src = src.slice(0, abs) + newTag + src.slice(abs + m[0].length);
          } else if (sized) {
            // A real frame: the image fills + crops to the shape, with its own
            // tint overlay. All four knobs (--tint, --tint-color, --obj-pos,
            // --obj-scale) are read from the frame, so the panel/drag controls
            // work without depending on the deck's own CSS.
            const imgStyle = "position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:var(--obj-pos,50% 50%); transform:scale(var(--obj-scale,1)); transform-origin:center; filter:grayscale(var(--tint,0)); opacity:var(--img-opacity,1); pointer-events:none; display:block;";
            const tintStyle = "position:absolute; inset:0; background:var(--tint-color,#16432e); opacity:var(--tint,0); mix-blend-mode:multiply; pointer-events:none; z-index:2;";
            const block = `<img data-fill="1" src="${dataUrl}" alt="" style="${imgStyle}" />\n  <div data-tint="1" style="${tintStyle}"></div>`;
            const inserted = insertFirstChild(src, ed, block);
            if (inserted == null) { toast("This box can't hold an image", "error"); return; }
            src = inserted;
          } else {
            // Flat placeholder with no height → a simple block image (fills width).
            const block = `<img data-fill="1" src="${dataUrl}" alt="" style="display:block; width:100%; height:auto; border-radius:inherit;" />`;
            const inserted = insertFirstChild(src, ed, block);
            if (inserted == null) { toast("This box can't hold an image", "error"); return; }
            src = inserted;
          }
        }
        visualEditRef.current = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } });
        setSelectedEd(null);
        iframeRef.current?.contentWindow?.postMessage({ type: "cm-deselect" }, "*");
        setPreviewKey(k => k + 1);
        toast("Image placed in the frame", "success");
      });
    },
    [readScaledDataUrl],
  );

  // "🖼 Ảnh" toolbar button → pour the picked image INTO the selected frame
  // (cropped to its shape), the same result as dragging a file onto it. The
  // user's flow: click the empty placeholder, click 🖼 Ảnh, pick a photo.
  const onImageFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const anchor = imageAnchorRef.current;
    if (!file || anchor == null) return;
    const o = frameOptsFromIframe(anchor);
    if (o && (o.tag === "html" || o.tag === "body")) {
      toast("Select an image frame (not the page background) first", "error");
      return;
    }
    fillBoxWithImage(anchor, file, {
      isImg: o?.isImg ?? false,
      relative: o?.relative ?? true,
      clip: o?.clip ?? true,
      boxH: o?.boxH ?? 0,
    });
  }, [frameOptsFromIframe, fillBoxWithImage]);

  // Delete the element at edIndex (its whole outer range) and reload the
  // preview. Triggered by the Delete/Backspace key in the preview or the panel
  // trash button.
  const deleteElement = useCallback((ed: number) => {
    const view = viewRef.current;
    if (!view) return;
    const src = view.state.doc.toString();
    const range = elementOuterRange(src, ed);
    if (!range) { toast("Couldn't locate the element", "error"); return; }
    const next = src.slice(0, range[0]) + src.slice(range[1]);
    visualEditRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    setSelectedEd(null);
    iframeRef.current?.contentWindow?.postMessage({ type: "cm-deselect" }, "*");
    setPreviewKey(k => k + 1);
    toast("Deleted", "success");
  }, []);

  // Splitter drag handlers
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const right = rect.right - e.clientX;
      const pct = (right / rect.width) * 100;
      setPreviewWidthPct(Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // Snapshot the preview doc ONLY at intentional reloads (previewKey), NOT on
  // every `current` change. Otherwise the iframe's srcDoc prop changes on each
  // visual edit and the browser reloads the iframe (scroll jumps to top, the
  // selection is lost) — even though we already applied the change live via
  // postMessage. Visual edits don't bump previewKey, so srcDoc stays stable.
  const previewDoc = useMemo(() => {
    if (ext === "md") {
      const escaped = current.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<html><head><style>body{font-family:system-ui;padding:24px;color:#1e293b;line-height:1.6;}pre{background:#f1f5f9;padding:12px;border-radius:6px;overflow:auto;}</style></head><body><pre>${escaped}</pre></body></html>`;
    }
    if (supportsInspect) return buildPreviewHtml(current, lastScrollRef.current, mode);
    return current;
    // `current` intentionally excluded: only re-render on a deliberate reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, ext, supportsInspect]);

  // Visual mode: left column becomes a fixed-width property-panel dock (the code
  // editor is hidden but stays MOUNTED — we still write edits into its doc),
  // preview flex-fills the rest so the panel never overlaps the slide. Splitter
  // hidden too. Non-visual: usual resizable code | preview.
  const visualFull = showPreview && mode === "visual";
  const aiFull = showPreview && mode === "ai";
  const dockFull = visualFull || aiFull;
  const editorWidth = !showPreview ? "100%" : dockFull ? "320px" : `${100 - previewWidthPct}%`;
  const previewWidth = showPreview && !dockFull ? `${previewWidthPct}%` : "0%";

  const modalEl = (
    <div
      className={cn(
        "fixed inset-0 z-[120] flex items-center justify-center bg-black/65 backdrop-blur-sm animate-fade-in",
        fullscreen ? "p-0" : "p-4",
      )}
      onClick={handleClose}
    >
      <div
        ref={modalRef}
        className={cn(
          "flex flex-col overflow-hidden border border-white/10 bg-[#262624] shadow-2xl ring-1 ring-black/40 animate-scale-in",
          fullscreen ? "h-screen w-screen max-w-none rounded-none" : "h-[92vh] w-full max-w-[1600px] rounded-2xl",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <FileText size={14} className="text-amber-300 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-slate-100">
              {file.name}
              {dirty && <span className="ml-2 text-amber-400">●</span>}
            </div>
            <div className="text-[10px] text-slate-500 tabular-nums">
              {(current.length / 1024).toFixed(1)} KB · {ext.toUpperCase()}
            </div>
          </div>
          {supportsInspect && showPreview && (
            <div className="flex items-center overflow-hidden rounded-lg border border-white/10 text-[11px]">
              <button
                onClick={() => setMode(m => (m === "inspect" ? "off" : "inspect"))}
                className={cn(
                  "flex items-center gap-1 px-2 py-1.5",
                  mode === "inspect"
                    ? "bg-amber-400/15 text-amber-200"
                    : "text-slate-300 hover:bg-white/10",
                )}
                title="Inspect: click an element to jump to its code line"
              >
                <MousePointerClick size={12} /> Inspect
              </button>
              <button
                onClick={() => setMode(m => (m === "visual" ? "off" : "visual"))}
                className={cn(
                  "flex items-center gap-1 border-l border-white/10 px-2 py-1.5",
                  mode === "visual"
                    ? "bg-sky-400/15 text-sky-200"
                    : "text-slate-300 hover:bg-white/10",
                )}
                title="Visual edit: click an element to change its text / size / color / box"
              >
                ✎ Visual edit
              </button>
              <button
                onClick={() => setMode(m => (m === "ai" ? "off" : "ai"))}
                className={cn(
                  "flex items-center gap-1 border-l border-white/10 px-2 py-1.5",
                  mode === "ai"
                    ? "bg-fuchsia-400/15 text-fuchsia-200"
                    : "text-slate-300 hover:bg-white/10",
                )}
                title="AI edit: drag a box over the part you want changed, then describe the change"
              >
                ✨ AI edit
              </button>
            </div>
          )}
          {(ext === "html" || ext === "htm") && (
            <div className="relative">
              <button
                onClick={() => setExportMenu(v => !v)}
                disabled={exporting}
                className="flex items-center gap-1 rounded-lg border border-sky-400/40 bg-sky-400/15 px-2.5 py-1.5 text-[11px] font-medium text-sky-200 hover:bg-sky-400/25 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Export .pptx: image version (pixel-perfect) or editable native version"
              >
                <FileText size={12} /> {exporting ? "Exporting…" : "Export PPTX"}
                {!exporting && <ChevronDown size={11} className="opacity-70" />}
              </button>
              {exportMenu && !exporting && (
                <>
                  {/* click ra ngoài để đóng */}
                  <div className="fixed inset-0 z-40" onClick={() => setExportMenu(false)} />
                  <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-white/10 bg-slate-900/95 shadow-xl backdrop-blur">
                    <button
                      onClick={() => exportPptx("image")}
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-white/10"
                    >
                      <span className="text-[11px] font-medium text-slate-100">PPTX image (not editable)</span>
                      <span className="text-[10px] text-slate-400">Each slide is one image, identical to the web. Text can't be edited.</span>
                    </button>
                    <button
                      onClick={() => exportPptx("native")}
                      className="flex w-full flex-col items-start gap-0.5 border-t border-white/10 px-3 py-2 text-left hover:bg-white/10"
                    >
                      <span className="text-[11px] font-medium text-sky-200">PPTX native (chỉnh sửa)</span>
                      <span className="text-[10px] text-slate-400">Box, chart và chữ đều là object riêng để chỉnh sửa. Kèm fade nhẹ khi chuyển slide. Font nhúng sẵn nên đúng trên mọi máy. Hình dạng phức tạp (skew/clip-path) được giữ dạng ảnh.</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="flex items-center overflow-hidden rounded-lg border border-white/10">
            <button
              onClick={() => { const v = viewRef.current; if (!v) return; undo(v); if (mode !== "visual") v.focus(); }}
              className="px-2 py-1.5 text-slate-300 hover:bg-white/10"
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <Undo2 size={13} />
            </button>
            <button
              onClick={() => { const v = viewRef.current; if (!v) return; redo(v); if (mode !== "visual") v.focus(); }}
              className="border-l border-white/10 px-2 py-1.5 text-slate-300 hover:bg-white/10"
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              <Redo2 size={13} />
            </button>
          </div>
          <button
            onClick={revert}
            disabled={!dirty}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-slate-300 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Discard changes"
          >
            <RotateCcw size={12} /> Revert
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-400/15 px-2.5 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-400/25 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Save (Ctrl+S)"
          >
            <Save size={12} /> {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={toggleFullscreen}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label="Toggle fullscreen"
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            onClick={handleClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            title="Close (Esc)"
            aria-label="Close editor"
          >
            <X size={16} />
          </button>
        </div>

        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={onImageFile} />

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">Loading…</div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center text-sm text-rose-300">Error: {error}</div>
        ) : (
          <div ref={containerRef} className="relative flex flex-1 overflow-hidden">
            <div
              className={cn(
                "flex flex-col overflow-hidden transition-[width] duration-150",
                dockFull && "shrink-0 border-r border-white/10 bg-[#262624]",
              )}
              style={{ width: editorWidth }}
            >
              {/* CodeMirror stays mounted (holds the doc we write into) but is
                  hidden while the property / AI panel occupies this column. */}
              <div ref={editorRef} className={cn("flex-1 overflow-auto file-editor-cm", dockFull && "hidden")} />
              {visualFull && (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-3 py-2">
                    <span className="mb-0.5 w-full text-[10px] font-medium text-sky-200/80">+ Add element</span>
                    {([
                      ["text", "T Text"], ["box", "▭ Box"], ["ellipse", "◯ Ellipse"],
                      ["line", "— Line"], ["image", "🖼 Fill image"],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => addElement(k)}
                        className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10"
                        title={selectedEd == null
                          ? "Select a frame on the slide first"
                          : k === "image" ? "Fill the selected frame with an image (crops to its shape)" : `Add ${k}`}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="flex flex-1 flex-col overflow-hidden">
                    {selectedEd != null ? (
                      <PropertyPanel
                        tag={selectedTag}
                        path={selPath}
                        styles={selStyles}
                        text={selText}
                        editable={selEditable}
                        isFrame={selIsFrame}
                        formatArmed={formatArmed}
                        onToggleFormatPainter={toggleFormatPainter}
                        onChange={applyStyle}
                        onLivePreview={livePreview}
                        onSelectPath={selectPath}
                        onText={applyText}
                        onClose={() => {
                          setSelectedEd(null);
                          iframeRef.current?.contentWindow?.postMessage({ type: "cm-deselect" }, "*");
                        }}
                        onDelete={() => { if (selectedEd != null) deleteElement(selectedEd); }}
                      />
                    ) : (
                      <div className="flex flex-1 items-center justify-center p-5 text-center text-[12px] leading-relaxed text-sky-200/70">
                        Click an element to edit it, or add a new one above (click a box first to pick the slide).
                      </div>
                    )}
                  </div>
                </div>
              )}
              {aiFull && (
                <div className="flex flex-1 flex-col overflow-hidden p-3">
                  <div className="mb-2 text-[11px] font-medium text-fuchsia-200/90">✨ AI edit</div>
                  {aiRegion == null ? (
                    <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.03] p-4 text-[12px] leading-relaxed text-slate-400">
                      Drag a box over the part of the slide you want to change. Everything inside the box is sent to the AI together; the rest of the file stays untouched.
                    </div>
                  ) : (
                    <>
                      <div className="mb-2 rounded-md bg-fuchsia-400/10 px-2.5 py-1.5 text-[11px] text-fuchsia-100/90">
                        {aiRegion.count} element{aiRegion.count > 1 ? "s" : ""} selected
                      </div>
                      <textarea
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        placeholder="e.g. make this heading bigger and navy; tighten the spacing"
                        rows={4}
                        disabled={aiBusy}
                        className="w-full resize-none rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 focus:border-fuchsia-400/40 focus:outline-none disabled:opacity-50"
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAiEdit(); } }}
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <div className="flex flex-col items-start">
                          <button
                            onClick={sendAiEdit}
                            disabled={aiBusy || !aiPrompt.trim()}
                            className="flex items-center gap-1 rounded-lg border border-fuchsia-400/40 bg-fuchsia-400/15 px-2.5 py-1.5 text-[11px] font-medium text-fuchsia-100 hover:bg-fuchsia-400/25 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {aiBusy ? "Editing…" : "Apply edit"}
                          </button>
                          {aiBusy && (
                            <div className="mt-1 text-[10px] font-medium tabular-nums text-fuchsia-300/85">
                              ✨ {aiElapsed}s
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            setAiRegion(null);
                            setAiPrompt("");
                            iframeRef.current?.contentWindow?.postMessage({ type: "cm-ai-clear" }, "*");
                          }}
                          disabled={aiBusy}
                          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="mt-2 text-[10px] text-slate-500">⌘/Ctrl+Enter to apply. Undo (Ctrl+Z) to revert.</div>
                    </>
                  )}
                </div>
              )}
            </div>

            {supportsPreview && (
              <>
                {/* Splitter / collapse handle (hidden when a dock occupies the column) */}
                {!dockFull && (
                <div
                  className={cn(
                    "group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-white/5 hover:bg-amber-400/40",
                    dragging && "bg-amber-400/60",
                    !showPreview && "cursor-pointer hover:bg-amber-400/40",
                  )}
                  onMouseDown={(e) => {
                    if (!showPreview) return;
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDoubleClick={() => setShowPreview(v => !v)}
                  title={showPreview ? "Drag to resize, double-click to collapse" : "Click to expand preview"}
                >
                  <button
                    onClick={() => setShowPreview(v => !v)}
                    className="absolute top-3 -translate-x-1/2 left-1/2 z-10 flex h-7 w-5 items-center justify-center rounded-md border border-white/10 bg-[#1a2138] text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-amber-300"
                    title={showPreview ? "Collapse preview" : "Expand preview"}
                  >
                    {showPreview ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                  </button>
                </div>
                )}

                <div
                  className={cn("bg-white transition-[width] duration-150", dockFull && "flex-1")}
                  style={dockFull ? undefined : { width: previewWidth }}
                >
                  {showPreview && (
                    <iframe
                      ref={iframeRef}
                      key={previewKey}
                      title="Preview"
                      className="h-full w-full border-0"
                      srcDoc={previewDoc}
                      sandbox="allow-same-origin allow-scripts"
                    />
                  )}
                </div>
              </>
            )}

            {/* Drag overlay to prevent iframe stealing pointer events */}
            {dragging && (
              <div className="absolute inset-0 z-50 cursor-col-resize" />
            )}
          </div>
        )}
      </div>
    </div>
  );

  // Portal to <body> so the modal escapes any transformed ancestor (which would
  // trap position:fixed inside a pane) — this is what lets CSS fullscreen cover
  // the real viewport without the Fullscreen API.
  return typeof document !== "undefined" ? createPortal(modalEl, document.body) : null;
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const SHADOW: Record<"none" | "sm" | "md" | "lg", string> = {
  none: "",
  sm: "0 1px 2px rgba(0,0,0,0.12)",
  md: "0 6px 18px -4px rgba(0,0,0,0.20)",
  lg: "0 16px 40px -12px rgba(0,0,0,0.30)",
};

/** Docked Visual-edit panel (left column): edit the clicked element's text +
 *  common CSS. Style controls call onChange(cssProp, cssValue, panelValue);
 *  text calls onText(text). Both live-update the preview and write to source. */
function PropertyPanel({ tag, path, styles, text, editable, isFrame, formatArmed, onToggleFormatPainter, onChange, onLivePreview, onSelectPath, onText, onClose, onDelete }: {
  tag: string;
  path: { ed: number; tag: string }[];
  styles: Record<string, string | number>;
  text: string;
  editable: boolean;
  isFrame: boolean;
  formatArmed: boolean;
  onToggleFormatPainter: () => void;
  onChange: (prop: string, cssValue: string, panelValue: string | number) => void;
  onLivePreview: (prop: string, cssValue: string) => void;
  onSelectPath: (ed: number) => void;
  onText: (text: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const num = (k: string) => { const n = Number(styles[k]); return Number.isFinite(n) ? n : 0; };
  const str = (k: string) => (typeof styles[k] === "string" ? (styles[k] as string) : "");
  const fontSize = num("font-size");
  const padding = num("padding");
  const bold = styles["font-weight"] === "bold";
  const align = str("text-align") || "left";
  const color = str("color") || "#1e293b";
  // Full background value (gradient / url / hex) for the free-text field.
  const bgCss = str("bg-css");
  const tx = num("tx");
  const ty = num("ty");
  const mkTranslate = (x: number, y: number) => (x === 0 && y === 0 ? "" : `translate(${x}vw, ${y}vh)`);

  // Hex text fields use local state so partial typing isn't reverted; they push
  // to onChange only when a valid hex, and resync when a new element is picked.
  const [colorHex, setColorHex] = useState(color);
  useEffect(() => { setColorHex(color); }, [color]);
  // Background is free text (solid / gradient / image). Local state so typing a
  // long gradient isn't reverted mid-edit; live-previews on change, commits to
  // source on blur. The colour swatch is just a shortcut to a solid hex.
  const [bgVal, setBgVal] = useState(bgCss);
  useEffect(() => { setBgVal(bgCss); }, [bgCss]);
  const bgPicker = HEX_RE.test(bgVal) ? bgVal : "#ffffff";
  // Position fields mirror the live drag offset (vw/vh); local state so manual
  // typing isn't reverted, resynced when the offset changes (drag / re-select).
  const [posX, setPosX] = useState(tx);
  const [posY, setPosY] = useState(ty);
  useEffect(() => { setPosX(tx); }, [tx]);
  useEffect(() => { setPosY(ty); }, [ty]);
  // Write-mostly box-style controls (border / shadow) — local UI state.
  const [borderW, setBorderW] = useState(0);
  const [borderC, setBorderC] = useState("#7dd3fc");
  const [shadowSel, setShadowSel] = useState<"none" | "sm" | "md" | "lg">("none");
  const opacity = num("opacity") || 100;
  const radius = num("border-radius");

  // Tint slider is smooth: dragging only live-previews (CSS var on one element,
  // no source rewrite); the value is committed to source once on release. Crop
  // position / zoom are done by dragging / wheeling the photo in the preview.
  const tintInit = Math.round((Number.isFinite(Number(styles["tint"])) ? Number(styles["tint"]) : 0.85) * 100);
  const [tintPct, setTintPct] = useState(tintInit);
  useEffect(() => { setTintPct(tintInit); }, [tintInit]);
  const tintColorInit = (typeof styles["tint-color"] === "string" && styles["tint-color"]) ? (styles["tint-color"] as string) : "#16432e";
  const [tintColor, setTintColor] = useState(tintColorInit);
  useEffect(() => { setTintColor(tintColorInit); }, [tintColorInit]);
  const imgOpInit = Math.round((Number.isFinite(Number(styles["imgop"])) ? Number(styles["imgop"]) : 1) * 100);
  const [imgOpPct, setImgOpPct] = useState(imgOpInit);
  useEffect(() => { setImgOpPct(imgOpInit); }, [imgOpInit]);

  const fieldCls = "rounded border border-white/10 bg-white/5 px-1.5 py-1 text-slate-100";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-sky-200">
          {path.length > 1 && (
            <button
              onClick={() => onSelectPath(path[path.length - 2].ed)}
              title="Select parent (container / page background)"
              className="rounded border border-white/10 bg-white/5 px-1 leading-none text-slate-300 hover:text-sky-200"
            >↑</button>
          )}
          Edit &lt;{tag}&gt;
        </span>
        <span className="flex items-center gap-0.5">
          <button onClick={onDelete} className="rounded p-0.5 text-slate-400 hover:text-rose-300" title="Delete element (Del)" aria-label="Delete element">
            <Trash2 size={13} />
          </button>
          <button onClick={onClose} className="rounded p-0.5 text-slate-400 hover:text-slate-100" aria-label="Deselect">
            <X size={13} />
          </button>
        </span>
      </div>
      {path.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-0.5 border-b border-white/10 px-3 py-1.5 text-[10px] leading-tight">
          {path.map((p, i) => (
            <span key={p.ed} className="flex items-center">
              {i > 0 && <span className="px-0.5 text-slate-600">›</span>}
              <button
                onClick={() => onSelectPath(p.ed)}
                title={`Select <${p.tag}>`}
                className={cn(
                  "rounded px-1 py-0.5 font-mono hover:bg-white/10",
                  i === path.length - 1 ? "font-semibold text-sky-300" : "text-slate-400 hover:text-slate-200",
                )}
              >{p.tag}</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex-1 space-y-4 overflow-auto p-3.5 text-[11px] text-slate-300">
        <button
          onClick={onToggleFormatPainter}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors",
            formatArmed
              ? "border-sky-400/60 bg-sky-400/20 text-sky-100"
              : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10",
          )}
          title="Copy this element's format, then click the element you want to apply it to"
        >{formatArmed ? "◉ Click an element to apply…" : "⧉ Copy format"}</button>
        {isFrame && (
          <div className="space-y-2 rounded-lg border border-sky-400/20 bg-sky-400/[0.04] p-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-200/80">🖼 Image frame</div>
            <div className="space-y-1">
              <span className="flex items-center justify-between">
                <span>Tint</span>
                <span className="flex items-center gap-1.5">
                  <input
                    type="color" value={tintColor} title="Tint colour"
                    onChange={e => { setTintColor(e.target.value); onChange("--tint-color", e.target.value, e.target.value); }}
                    className="h-5 w-7 cursor-pointer rounded border border-white/10 bg-transparent"
                  />
                  <span className="w-9 text-right text-slate-500">{tintPct}%</span>
                </span>
              </span>
              <input
                type="range" min={0} max={100} value={tintPct}
                onChange={e => { const v = Number(e.target.value); setTintPct(v); onLivePreview("--tint", `${v / 100}`); }}
                onPointerUp={e => onChange("--tint", `${Number((e.target as HTMLInputElement).value) / 100}`, tintPct)}
                onKeyUp={() => onChange("--tint", `${tintPct / 100}`, tintPct)}
                className="w-full accent-sky-400"
              />
              <div className="flex gap-1">
                {([["None", 0], ["Light", 30], ["Medium", 60], ["Strong", 90]] as const).map(([lbl, v]) => (
                  <button
                    key={v}
                    onClick={() => { setTintPct(v); onChange("--tint", `${v / 100}`, v); }}
                    className="flex-1 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-white/10"
                  >{lbl}</button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <span className="flex items-center justify-between"><span>Image opacity</span><span className="text-slate-500">{imgOpPct}%</span></span>
              <input
                type="range" min={0} max={100} value={imgOpPct}
                onChange={e => { const v = Number(e.target.value); setImgOpPct(v); onLivePreview("--img-opacity", `${v / 100}`); }}
                onPointerUp={e => onChange("--img-opacity", `${Number((e.target as HTMLInputElement).value) / 100}`, imgOpPct)}
                onKeyUp={() => onChange("--img-opacity", `${imgOpPct / 100}`, imgOpPct)}
                className="w-full accent-sky-400"
              />
            </div>
            <div className="rounded border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-slate-400">
              ✋ <b className="text-slate-300">Drag the photo</b> to reposition · <b className="text-slate-300">scroll</b> to zoom.
            </div>
            <button
              onClick={() => { onChange("--obj-pos", "50% 50%", 50); onChange("--obj-scale", "1", 100); }}
              className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-300 hover:bg-white/10"
            >Reset position / zoom</button>
          </div>
        )}
        {editable && (
          <div className="space-y-1">
            <div className="text-slate-400">Text</div>
            <textarea
              value={text} rows={3}
              onChange={e => onText(e.target.value)}
              className={cn(fieldCls, "w-full resize-y leading-snug")}
            />
          </div>
        )}

        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Text</div>
        <label className="flex items-center justify-between gap-2">
          <span>Font size</span>
          <span className="flex items-center gap-1">
            <input
              type="number" min={6} max={300} value={fontSize}
              onChange={e => onChange("font-size", `${e.target.value}px`, Number(e.target.value))}
              className={cn(fieldCls, "w-16 text-right")}
            />
            <span className="text-slate-500">px</span>
          </span>
        </label>

        <div className="flex items-center justify-between gap-2">
          <span>Style</span>
          <div className="flex gap-1">
            <button
              onClick={() => onChange("font-weight", bold ? "normal" : "bold", bold ? "normal" : "bold")}
              className={cn("rounded border px-2 py-1 font-bold", bold ? "border-sky-400/40 bg-sky-400/15 text-sky-200" : "border-white/10 bg-white/5 text-slate-300")}
              title="Bold"
            >B</button>
            {(["left", "center", "right"] as const).map(a => (
              <button
                key={a}
                onClick={() => onChange("text-align", a, a)}
                className={cn("rounded border px-1.5 py-1", align === a ? "border-sky-400/40 bg-sky-400/15 text-sky-200" : "border-white/10 bg-white/5 text-slate-300")}
                title={`Align ${a}`}
              >{a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}</button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span>Text color</span>
          <span className="flex items-center gap-1">
            <input
              type="text" value={colorHex} placeholder="#000000" spellCheck={false}
              onChange={e => { const v = e.target.value; setColorHex(v); if (HEX_RE.test(v)) onChange("color", v, v); }}
              className={cn(fieldCls, "w-20 font-mono")}
            />
            <input
              type="color" value={color}
              onChange={e => onChange("color", e.target.value, e.target.value)}
              className="h-6 w-8 cursor-pointer rounded border border-white/10 bg-transparent"
            />
          </span>
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Box &amp; layout</div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span>Background</span>
            <span className="flex items-center gap-1">
              <input
                type="color" value={bgPicker}
                onChange={e => { setBgVal(e.target.value); onChange("background", e.target.value, e.target.value); }}
                title="Pick a solid color"
                className="h-6 w-8 cursor-pointer rounded border border-white/10 bg-transparent"
              />
              <button
                onClick={() => { setBgVal(""); onChange("background", "", ""); }}
                title="Clear background"
                className="rounded border border-white/10 bg-white/5 px-1.5 py-1 text-slate-400 hover:text-slate-100"
              >∅</button>
            </span>
          </div>
          <input
            type="text" value={bgVal} spellCheck={false}
            placeholder="#fff · rgb(…) · linear-gradient(…) · url(…)"
            onChange={e => { setBgVal(e.target.value); onLivePreview("background", e.target.value); }}
            onBlur={e => onChange("background", e.target.value, e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className={cn(fieldCls, "w-full font-mono text-[10px]")}
          />
          <div className="text-[10px] leading-snug text-slate-500">
            Type a color, gradient or image — overrides an existing gradient/image too. Use ↑ to select the container when changing a whole page background.
          </div>
        </div>

        <label className="flex items-center justify-between gap-2">
          <span>Padding</span>
          <span className="flex items-center gap-1">
            <input
              type="number" min={0} max={300} value={padding}
              onChange={e => onChange("padding", `${e.target.value}px`, Number(e.target.value))}
              className={cn(fieldCls, "w-16 text-right")}
            />
            <span className="text-slate-500">px</span>
          </span>
        </label>

        <div className="flex items-center justify-between gap-2">
          <span>Width / Height</span>
          <span className="flex items-center gap-1">
            <input
              type="text" placeholder="auto" value={str("width")}
              onChange={e => onChange("width", e.target.value, e.target.value)}
              className={cn(fieldCls, "w-14")}
            />
            <input
              type="text" placeholder="auto" value={str("height")}
              onChange={e => onChange("height", e.target.value, e.target.value)}
              className={cn(fieldCls, "w-14")}
            />
          </span>
        </div>

        <label className="flex items-center justify-between gap-2">
          <span>Opacity</span>
          <span className="flex items-center gap-1">
            <input
              type="number" min={0} max={100} value={opacity}
              onChange={e => onChange("opacity", `${Number(e.target.value) / 100}`, Number(e.target.value))}
              className={cn(fieldCls, "w-16 text-right")}
            />
            <span className="text-slate-500">%</span>
          </span>
        </label>

        <label className="flex items-center justify-between gap-2">
          <span>Corner radius</span>
          <span className="flex items-center gap-1">
            <input
              type="number" min={0} max={400} value={radius}
              onChange={e => onChange("border-radius", `${e.target.value}px`, Number(e.target.value))}
              className={cn(fieldCls, "w-16 text-right")}
            />
            <span className="text-slate-500">px</span>
          </span>
        </label>

        <div className="flex items-center justify-between gap-2">
          <span>Border</span>
          <span className="flex items-center gap-1">
            <input
              type="number" min={0} max={20} value={borderW} title="Border width (px)"
              onChange={e => { const w = Number(e.target.value); setBorderW(w); onChange("border", w > 0 ? `${w}px solid ${borderC}` : "", w); }}
              className={cn(fieldCls, "w-12 text-right")}
            />
            <input
              type="color" value={borderC}
              onChange={e => { setBorderC(e.target.value); if (borderW > 0) onChange("border", `${borderW}px solid ${e.target.value}`, borderW); }}
              className="h-6 w-8 cursor-pointer rounded border border-white/10 bg-transparent"
            />
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span>Shadow</span>
          <div className="flex gap-1">
            {(["none", "sm", "md", "lg"] as const).map(s => (
              <button
                key={s}
                onClick={() => { setShadowSel(s); onChange("box-shadow", SHADOW[s], s); }}
                className={cn("rounded border px-1.5 py-1", shadowSel === s ? "border-sky-400/40 bg-sky-400/15 text-sky-200" : "border-white/10 bg-white/5 text-slate-300")}
              >{s}</button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span>Layer</span>
          <div className="flex gap-1">
            <button
              onClick={() => onChange("z-index", "50", "50")}
              className="rounded border border-white/10 bg-white/5 px-2 py-1 text-slate-300 hover:bg-white/10"
              title="Bring to front"
            >▲ Front</button>
            <button
              onClick={() => onChange("z-index", "0", "0")}
              className="rounded border border-white/10 bg-white/5 px-2 py-1 text-slate-300 hover:bg-white/10"
              title="Send to back"
            >▼ Back</button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span>Position (drag)</span>
            <span className="flex items-center gap-1">
              <input
                type="number" step={0.5} value={posX} title="X offset (vw)"
                onChange={e => { const x = Number(e.target.value); setPosX(x); onChange("transform", mkTranslate(x, posY), mkTranslate(x, posY)); }}
                className={cn(fieldCls, "w-14 text-right")}
              />
              <input
                type="number" step={0.5} value={posY} title="Y offset (vh)"
                onChange={e => { const y = Number(e.target.value); setPosY(y); onChange("transform", mkTranslate(posX, y), mkTranslate(posX, y)); }}
                className={cn(fieldCls, "w-14 text-right")}
              />
              <button
                onClick={() => { setPosX(0); setPosY(0); onChange("transform", "", ""); }}
                title="Reset position"
                className="rounded border border-white/10 bg-white/5 px-1.5 py-1 text-slate-400 hover:text-slate-100"
              >∅</button>
            </span>
          </div>
          <div className="text-[10px] leading-snug text-slate-500">
            Drag the box in the preview to move it · drag the bottom-right corner to resize.
          </div>
        </div>

        <div className="text-[10px] leading-snug text-slate-500">
          <span className="text-slate-300">Ctrl+C</span> a box, click another box, then <span className="text-slate-300">Ctrl+V</span> to paste a copy. Arrow keys nudge it (Shift = bigger step).
        </div>

        <p className="pt-1 text-[10px] leading-snug text-slate-500">
          Click <span className="text-emerald-300">Save</span> when done. JS-drawn content (charts) can&apos;t be edited here.
        </p>
      </div>
    </div>
  );
}
