// One-shot HTML fragment editor for the Visual editor's "AI edit" mode.
//
// The editor sends a single HTML fragment (the common-ancestor element of the
// region the user boxed) plus a natural-language instruction. We ask the model
// to return ONLY the modified fragment, same root element, so the caller can
// splice it straight back over the original char range. No tools, no MCP, no
// settings scan — a pure completion, mirroring lib/orchestrator.ts.
//
// Speed: routed through the warm session pool (lib/session-pool) instead of a
// fresh query() each time. The Agent SDK spawns a `claude` CLI subprocess per
// query() (~5-9s cold). By keeping ONE warm subprocess alive for AI-edit, the
// 2nd+ edits reuse it (~spawn cost gone), and `prewarmAiEdit()` lets the UI
// pay the spawn during the user's box-drag/typing time so even the 1st edit
// feels instant.
import { type Options, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { reuseSession, createWarmSession, preWarmSession } from "./session-pool";

// Sonnet is fast and strong at surgical HTML/CSS edits; the task is narrow.
const MODEL = "claude-sonnet-4-6";

const SYSTEM = `You are a precise HTML/CSS editor embedded in a visual slide editor.
You receive ONE HTML fragment (a single root element with its children) and an instruction describing what to change.
Each request is INDEPENDENT: only the fragment in the current message matters. Ignore any fragments from earlier messages in this conversation.
Rules:
- Apply ONLY what the instruction asks. Leave everything else byte-for-byte unchanged: text, attributes, inline styles, classes, indentation, whitespace.
- Keep the SAME root element (same tag and its attributes unless the instruction is explicitly about them) so the fragment can be spliced back in place.
- Prefer inline style="" edits for visual tweaks; do not invent new external CSS or <style> blocks.
- Output ONLY the modified fragment. No markdown code fences, no backticks, no explanation, no leading or trailing prose.`;

function buildOptions(model: string): Options {
  return {
    model,
    // Pass systemPrompt as a string[] with the dynamic boundary at the end so
    // the entire SYSTEM block sits in the cacheable prefix. Saves ~100-200ms
    // TTFT per edit + reduces tokens billed (Anthropic prompt caching).
    systemPrompt: [SYSTEM, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
    allowedTools: [],
    mcpServers: {} as Record<string, never>,
    settingSources: [],
    maxTurns: 1,
  };
}

// Shared pool key + options signature for the single warm AI-edit subprocess.
// One key (per model) is fine: a single user edits one fragment at a time, and
// reuseSession() falls back to a fresh subprocess if the pool entry is busy.
function poolKey(model: string): string {
  return `util:ai-edit:${model}`;
}
function optionsSig(model: string): string {
  return `${model}|ai-edit`;
}

/** Remove an accidental ```lang ... ``` wrapper the model may add despite the
 *  instruction. */
function stripFences(s: string): string {
  let t = s.trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  return t.trim();
}

/** Pre-spawn the AI-edit subprocess so it's warm before the first edit. Fired
 *  by the UI when the user enters AI-edit mode. No-op if already warm. */
export function prewarmAiEdit(model = MODEL): void {
  preWarmSession(poolKey(model), optionsSig(model), buildOptions(model));
}

export async function editHtmlFragment(
  snippet: string,
  instruction: string,
  model = MODEL,
): Promise<string> {
  const prompt = `Instruction:\n${instruction}\n\nHTML fragment to edit:\n${snippet}`;
  const key = poolKey(model);
  const sig = optionsSig(model);

  // Reuse a warm subprocess if one is sitting idle in the pool; otherwise spawn
  // a fresh one and register it so the NEXT edit reuses it.
  const handle =
    reuseSession(key, sig, prompt) ??
    createWarmSession(key, sig, buildOptions(model), prompt);

  let text = "";
  for await (const _msg of handle.events) {
    const m = _msg as {
      type: string;
      message?: { content: Array<{ type: string; text?: string }> };
    };
    if (m.type === "assistant" && m.message) {
      for (const block of m.message.content) {
        if (block.type === "text" && block.text) text += block.text;
      }
    }
  }

  const out = stripFences(text);
  if (!out) throw new Error("Empty response from model");
  return out;
}
