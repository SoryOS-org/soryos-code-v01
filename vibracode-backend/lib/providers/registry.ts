/**
 * Provider registry — the single place that maps model ids to providers,
 * exposes the UI catalogue, and instantiates adapters.
 *
 * The old Anthropic ids (`claude-*`) are still accepted for backwards
 * compatibility and routed to OpenRouter.
 */

import { AIProvider, ModelInfo, ProviderConfig, ProviderId } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { GeminiProvider, GEMINI_MODELS } from "./gemini";
import { MistralProvider, MISTRAL_MODELS } from "./mistral";
import { OpenRouterProvider, OPENROUTER_MODELS } from "./openrouter";

export interface ProviderMetadata {
  id: ProviderId;
  label: string;
  description: string;
  defaultModel: string;
  /** Server-side env var that must hold the API key. */
  envVar: string;
  /** Pretty URL shown in the UI. */
  docsUrl: string;
}

export const PROVIDERS_METADATA: Record<ProviderId, ProviderMetadata> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter Free",
    description: "OpenAI-compatible gateway to the OpenRouter free model pool.",
    defaultModel: "openrouter/free",
    envVar: "OPENROUTER_API_KEY",
    docsUrl: "https://openrouter.ai/docs",
  },
  mistral: {
    id: "mistral",
    label: "Mistral AI",
    description: "Official Mistral API; select any Mistral or Devstral model.",
    defaultModel: "mistral-large-latest",
    envVar: "MISTRAL_API_KEY",
    docsUrl: "https://docs.mistral.ai",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    description: "Official Google Generative Language API.",
    defaultModel: "gemini-2.5-flash",
    envVar: "GEMINI_API_KEY",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
};

const MISTRAL_PREFIXES = [
  "mistral-",
  "ministral-",
  "devstral-",
  "codestral-",
  "open-mistral",
  "open-mixtral",
  "magistral-",
  "pixtral-",
  "mistralai/",
];

const LEGACY_ANTHROPIC_PREFIX = "claude-";

export function isGeminiModelId(model?: string | null): boolean {
  return Boolean(model && model.startsWith("gemini-"));
}

export function isMistralModelId(model?: string | null): boolean {
  if (!model) return false;
  return MISTRAL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export function isOpenRouterModelId(model?: string | null): boolean {
  if (!model) return false;
  return model.endsWith(":free") || model.startsWith("openrouter/") || model.startsWith("openrouter");
}

/**
 * Resolve which provider must execute a given model id.
 * Unknown ids fall back to OpenRouter (the default engine).
 */
export function resolveProvider(model?: string | null, fallback: ProviderId = "openrouter"): ProviderId {
  if (!model) return fallback;
  if (isGeminiModelId(model)) return "gemini";
  if (isMistralModelId(model)) return "mistral";
  if (isOpenRouterModelId(model)) return "openrouter";
  if (model.startsWith(LEGACY_ANTHROPIC_PREFIX)) return "openrouter";
  return fallback;
}

/**
 * Decides which engine must execute a message for a given model id.
 *
 * - native providers (openrouter/mistral/gemini) run through the backend engine
 *   (`lib/providers/engine.ts`) — this is the default for all of them,
 * - the `cursor` agent keeps running as a CLI inside the E2B sandbox because it
 *   uses proprietary tokens/billing that cannot run on this server.
 *
 * `AGENT_ENGINE` overrides the behaviour:
 *   - `auto` (default)   -> backend engine for native providers, CLI for cursor
 *   - `provider`         -> always the backend engine (cursor keeps CLI)
 *   - `cli`              -> always the legacy CLI engine (full rollback)
 */
export type AgentEngine = "provider" | "cli";

export interface EngineRoute {
  engine: AgentEngine;
  provider: ProviderId;
}

export function resolveEngine(model?: string | null, options: { agentType?: string } = {}): EngineRoute {
  const forced = (process.env.AGENT_ENGINE || "auto").trim().toLowerCase();
  const agentType = (options.agentType || process.env.AGENT_TYPE || "claude").trim().toLowerCase();
  const provider = resolveProvider(model || undefined);

  if (forced === "cli") return { engine: "cli", provider };
  if (forced === "provider") return { engine: "provider", provider };
  if (agentType === "cursor") return { engine: "cli", provider };
  return { engine: "provider", provider };
}

export function createProvider(id: ProviderId, config?: ProviderConfig): AIProvider;
export function createProvider(id: "openrouter", config?: ProviderConfig): OpenRouterProvider;
export function createProvider(id: "mistral", config?: ProviderConfig): MistralProvider;
export function createProvider(id: "gemini", config?: ProviderConfig): GeminiProvider;
export function createProvider(id: ProviderId, config: ProviderConfig = {}): AIProvider {
  switch (id) {
    case "mistral":
      return new MistralProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    case "openrouter":
    default:
      return new OpenRouterProvider(config);
  }
}

export function createProviders(config: ProviderConfig = {}): Record<ProviderId, AIProvider> {
  return {
    openrouter: createProvider("openrouter", config),
    mistral: createProvider("mistral", config),
    gemini: createProvider("gemini", config),
  };
}

export function getProviderForModel(
  model: string | null | undefined,
  providers: Record<ProviderId, AIProvider>
): { provider: AIProvider; providerId: ProviderId; model: string } {
  const providerId = resolveProvider(model);
  const provider = providers[providerId];
  return { provider, providerId, model: model || provider.defaultModel };
}

export interface CatalogProvider {
  metadata: ProviderMetadata;
  configured: boolean;
  models: ModelInfo[];
}

/** Full catalogue for the model/provider selector (no secrets included). */
export function getProviderCatalog(config: ProviderConfig = {}): CatalogProvider[] {
  const order: ProviderId[] = ["openrouter", "mistral", "gemini"];
  return order.map((id) => {
    const provider = createProvider(id, config);
    return {
      metadata: PROVIDERS_METADATA[id],
      configured: provider.isConfigured(),
      models: provider.listModels(),
    };
  });
}

export function allModelIds(): string[] {
  return [
    ...OPENROUTER_MODELS.map((m) => m.id),
    ...MISTRAL_MODELS.map((m) => m.id),
    ...GEMINI_MODELS.map((m) => m.id),
  ];
}

/**
 * Some callers only need the generic adapter without knowing the concrete type.
 * Exposed for tests and for backwards-compatible wiring.
 */
export { OpenAICompatibleProvider };
