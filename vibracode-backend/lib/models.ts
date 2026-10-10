/**
 * Central catalog of AI models exposed by Vibra Code.
 *
 * Two providers are supported, both on free tiers:
 *   - OpenRouter free models (`:free` suffix) -> executed by the Claude Code CLI
 *     pointed at OpenRouter (see lib/e2b/config.ts)
 *   - Google Gemini models -> executed by the Gemini CLI against the Google AI
 *     Studio free tier (GEMINI_API_KEY)
 *
 * This module is the single source of truth for:
 *   - the model lists rendered by the web + iOS selectors
 *   - the default model used when a client does not send one
 *   - resolving which agent must execute a given model
 */

export type AgentType = "claude" | "cursor" | "gemini";

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  /** False when the model cannot drive an agentic coding loop (no tool calling). */
  tools: boolean;
}

/**
 * All OpenRouter models with a `:free` variant (queried 2026-10-10).
 * Rate limits: roughly 20 requests/minute and 50 requests/day per key.
 */
export const OPENROUTER_FREE_MODELS: ModelOption[] = [
  { id: "cohere/north-mini-code:free", name: "North Mini Code", description: "Coding model, 256k context", tools: true },
  { id: "thinkingmachines/inkling:free", name: "Inkling", description: "Frontier model, 1M context", tools: true },
  { id: "thinkingmachines/inkling-small:free", name: "Inkling Small", description: "Fast, 1M context", tools: true },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super", description: "120B, strong reasoning", tools: true },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning", description: "Fast and lightweight", tools: true },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni", description: "30B reasoning, multimodal", tools: true },
  { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1", description: "Software engineering model", tools: true },
  { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1", description: "Small software engineering model", tools: true },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", description: "Google open model, 262k context", tools: true },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B", description: "Google open model, efficient MoE", tools: true },
  { id: "apodex/apodex-1.1-mini:free", name: "Apodex 1.1 Mini", description: "Compact general model", tools: true },
  { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note", description: "Multimodal preview model", tools: true },
  { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B", description: "Ultra-small on-device model", tools: true },
  { id: "nvidia/nemotron-3.5-content-safety:free", name: "Nemotron 3.5 Safety", description: "No tool calling - not for the agent", tools: false },
];

/**
 * Google Gemini models available on the Google AI Studio free tier (2026-10-10).
 * gemini-2.0-* was shut down on 2026-06-01, so 2.5 is the oldest family served.
 * gemini-3.1-pro-preview and every image model are paid-only and excluded.
 */
export const GEMINI_MODELS: ModelOption[] = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Newest Flash, best for agents", tools: true },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", description: "Strong coding and agentic workflows", tools: true },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", description: "Token efficient, stable", tools: true },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", description: "Frontier performance, stable", tools: true },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", description: "Low latency, high free quota", tools: true },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", description: "Cheap and fast, high free quota", tools: true },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", description: "First Gemini 3 Flash", tools: true },
];

export const ALL_AGENT_MODELS: ModelOption[] = [
  ...OPENROUTER_FREE_MODELS,
  ...GEMINI_MODELS,
];

/** Used by the Claude Code CLI when the client does not pick a model. */
export const DEFAULT_OPENROUTER_MODEL = "cohere/north-mini-code:free";
/** Used by the Gemini CLI when the client does not pick a model (500 req/day free). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
/** Global default: the Claude Code agent running on OpenRouter free models. */
export const DEFAULT_AGENT_MODEL = DEFAULT_OPENROUTER_MODEL;

/**
 * Anthropic model ids still persisted by already-released clients
 * (web localStorage `selectedClaudeModel`, iOS NSUserDefaults `SelectedClaudeModel`).
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4-5-20251101": DEFAULT_OPENROUTER_MODEL,
  "claude-sonnet-4-5": DEFAULT_OPENROUTER_MODEL,
  "claude-haiku-4-5": DEFAULT_OPENROUTER_MODEL,
};

export function isOpenRouterModel(model?: string | null): boolean {
  if (!model) return false;
  return model.endsWith(":free") || model.startsWith("openrouter/");
}

export function isGeminiModel(model?: string | null): boolean {
  if (!model) return false;
  return model.startsWith("gemini-");
}

export function isLegacyClaudeModel(model?: string | null): boolean {
  if (!model) return false;
  return model.startsWith("claude-");
}

/** Translate any client-side model id into an id this deployment can execute. */
export function resolveModel(model?: string | null, agentType?: AgentType): string {
  const id = (model || "").trim();
  const fallback = agentType === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL;
  if (!id) return fallback;
  if (LEGACY_MODEL_ALIASES[id]) return LEGACY_MODEL_ALIASES[id];
  // Only ids that are still listed in the catalogs can be executed - anything
  // else (retired endpoint, paid id, typo) falls back to the safe default.
  if (isGeminiModel(id)) return GEMINI_MODELS.some(entry => entry.id === id) ? id : DEFAULT_GEMINI_MODEL;
  if (isOpenRouterModel(id)) return OPENROUTER_FREE_MODELS.some(entry => entry.id === id) ? id : DEFAULT_OPENROUTER_MODEL;
  if (isLegacyClaudeModel(id)) return DEFAULT_OPENROUTER_MODEL;
  return fallback;
}

/**
 * Pick the agent that must execute a model.
 * OpenRouter free models are consumed by the Claude Code CLI, Gemini models by
 * the Gemini CLI. A deployment pinned to `cursor` keeps its cursor agent unless
 * the user explicitly picks a Gemini model.
 */
export function resolveAgentType(model?: string | null, fallback?: string): AgentType {
  const raw = (fallback || "").trim();
  const resolved: AgentType =
    raw === "cursor" ? "cursor" : raw === "gemini" ? "gemini" : "claude";
  const id = (model || "").trim();
  if (!id) return resolved;
  if (isGeminiModel(id)) return "gemini";
  if (isOpenRouterModel(id) || isLegacyClaudeModel(id)) {
    return resolved === "cursor" ? "cursor" : "claude";
  }
  return resolved;
}
