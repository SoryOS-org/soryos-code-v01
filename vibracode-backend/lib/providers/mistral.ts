/**
 * Mistral AI provider — official Mistral API (OpenAI-compatible chat endpoint).
 *
 * The model is selectable; the default is `mistral-large-latest`. Tool calling
 * is supported by the `*-latest` family and the Devstral coding models.
 */

import { ModelInfo, ProviderConfig } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible";

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

export const MISTRAL_MODELS: ModelInfo[] = [
  { id: "mistral-large-latest", name: "Mistral Large", description: "Flagship model, best for agents", toolCalling: true, contextLength: 131072 },
  { id: "mistral-medium-latest", name: "Mistral Medium", description: "Balanced cost and quality", toolCalling: true, contextLength: 131072 },
  { id: "mistral-small-latest", name: "Mistral Small", description: "Fast and cheap", toolCalling: true, contextLength: 131072 },
  { id: "devstral-small-latest", name: "Devstral Small", description: "Software engineering model", toolCalling: true, contextLength: 131072 },
  { id: "devstral-medium-latest", name: "Devstral Medium", description: "Software engineering model", toolCalling: true, contextLength: 131072 },
  { id: "codestral-latest", name: "Codestral", description: "Code generation model", toolCalling: true, contextLength: 262144 },
  { id: "ministral-8b-latest", name: "Ministral 8B", description: "Small edge model", toolCalling: true, contextLength: 131072 },
  { id: "open-mistral-nemo", name: "Mistral NeMo", description: "Open model; tool calling limited", toolCalling: false, contextLength: 131072 },
];

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export class MistralProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig = {}) {
    super({
      id: "mistral",
      label: "Mistral AI",
      defaultModel: getEnv("MISTRAL_DEFAULT_MODEL") || "mistral-large-latest",
      defaultBaseUrl: config.baseUrl || getEnv("MISTRAL_BASE_URL") || MISTRAL_BASE_URL,
      apiKey: config.apiKey ?? getEnv("MISTRAL_API_KEY"),
      models: MISTRAL_MODELS,
      defaultToolCalling: true,
      fetchImpl: config.fetchImpl,
      // Mistral returns usage in the final stream chunk by default.
      sendStreamOptions: false,
      defaultHeaders: config.headers,
    });
  }
}
