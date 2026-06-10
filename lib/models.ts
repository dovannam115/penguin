// Model registry — which model each "employee" runs on.
//
// Two providers:
//   - "claude"     → Claude models via the Claude Agent SDK (Max-plan auth,
//                    full Bash + filesystem tools).
//   - "openrouter" → everything else via OpenRouter's OpenAI-compatible API
//                    (OpenAI, Google Gemini, DeepSeek, Llama, ...). Keeps the
//                    office file-export tools, but NO Bash / raw filesystem.
//
// OpenRouter already proxies Google Gemini, so there is no separate Gemini
// provider — Gemini models just live under OpenRouter ("or:google/...").
//
// employee.model is a plain string stored in SQLite. The provider is encoded
// as a prefix so existing rows ("claude-sonnet-4-6") keep working with no DB
// migration:
//   - "claude-*"  → Claude     (Agent SDK)
//   - "or:<slug>" → OpenRouter (e.g. "or:google/gemini-2.5-flash")

export type Provider = "claude" | "openrouter";

export interface ModelDef {
  id: string;
  label: string;
  provider: Provider;
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude (Max plan)",
  openrouter: "OpenRouter",
};

export const MODEL_REGISTRY: ModelDef[] = [
  // ── Claude — via Claude Agent SDK, full Bash + filesystem tools ──
  { id: "claude-fable-5",    label: "Fable 5",    provider: "claude" },
  { id: "claude-opus-4-8",   label: "Opus 4.8",   provider: "claude" },
  { id: "claude-opus-4-7",   label: "Opus 4.7",   provider: "claude" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", provider: "claude" },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5",  provider: "claude" },

  // ── OpenRouter — chỉ các model rẻ (gồm cả Gemini). Cần API key. ──
  { id: "or:openai/gpt-4o-mini",                label: "GPT-4o mini",      provider: "openrouter" },
  { id: "or:google/gemini-2.5-flash",           label: "Gemini 2.5 Flash", provider: "openrouter" },
  { id: "or:google/gemini-2.0-flash-001",       label: "Gemini 2.0 Flash", provider: "openrouter" },
  { id: "or:deepseek/deepseek-chat",            label: "DeepSeek Chat",    provider: "openrouter" },
  { id: "or:meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B",    provider: "openrouter" },
];

/** Split a stored model id into its provider + the raw model name to send. */
export function parseModel(model: string): { provider: Provider; modelName: string } {
  if (model.startsWith("or:")) return { provider: "openrouter", modelName: model.slice(3) };
  return { provider: "claude", modelName: model };
}

export function modelProvider(model: string): Provider {
  return parseModel(model).provider;
}

export function modelLabel(model: string): string {
  const def = MODEL_REGISTRY.find(m => m.id === model);
  if (def) return def.label;
  const { provider, modelName } = parseModel(model);
  return provider === "claude" ? modelName : `${modelName} · tùy chỉnh`;
}

/** Build a model id for a custom (non-registry) model name typed by the user. */
export function customModelId(provider: Provider, raw: string): string {
  const name = raw.trim();
  if (!name) return "";
  if (provider === "openrouter") return name.startsWith("or:") ? name : `or:${name}`;
  return name;
}
