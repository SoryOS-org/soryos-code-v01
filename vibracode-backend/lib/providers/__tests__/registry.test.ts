import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveProvider,
  resolveEngine,
  createProvider,
  createProviders,
  getProviderForModel,
  getProviderCatalog,
  allModelIds,
  isGeminiModelId,
  isMistralModelId,
  isOpenRouterModelId,
} from "../registry";

async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("registry: is*ModelId classify by prefix/suffix", () => {
  assert.equal(isGeminiModelId("gemini-2.5-flash"), true);
  assert.equal(isGeminiModelId("openrouter/free"), false);
  assert.equal(isMistralModelId("mistral-large-latest"), true);
  assert.equal(isMistralModelId("devstral-small-latest"), true);
  assert.equal(isMistralModelId("mistralai/foo"), true);
  assert.equal(isMistralModelId("gemini-x"), false);
  assert.equal(isOpenRouterModelId("openrouter/free"), true);
  assert.equal(isOpenRouterModelId("qwen/qwen3-coder:free"), true);
  assert.equal(isOpenRouterModelId("gemini-x"), false);
});

test("registry: resolveProvider picks the right provider", () => {
  assert.equal(resolveProvider("gemini-3.5-flash"), "gemini");
  assert.equal(resolveProvider("mistral-medium-latest"), "mistral");
  assert.equal(resolveProvider("qwen/qwen3-coder:free"), "openrouter");
  assert.equal(resolveProvider("claude-sonnet-4-5"), "openrouter");
  assert.equal(resolveProvider("mystery-model"), "openrouter");
  assert.equal(resolveProvider("", "gemini"), "gemini");
  assert.equal(resolveProvider(undefined, "mistral"), "mistral");
});

test("registry: resolveEngine prefers the native backend engine", async () => {
  await withEnv("AGENT_ENGINE", "", async () => {
    await withEnv("AGENT_TYPE", "", async () => {
      assert.deepEqual(resolveEngine("gemini-2.5-flash"), { engine: "provider", provider: "gemini" });
      assert.deepEqual(resolveEngine("mistral-large-latest"), { engine: "provider", provider: "mistral" });
      assert.deepEqual(resolveEngine("openrouter/free"), { engine: "provider", provider: "openrouter" });
      assert.deepEqual(resolveEngine("", { agentType: "claude" }), { engine: "provider", provider: "openrouter" });
    });
  });
});

test("registry: cursor keeps the legacy CLI engine", async () => {
  await withEnv("AGENT_ENGINE", "", async () => {
    assert.deepEqual(resolveEngine("openrouter/free", { agentType: "cursor" }), { engine: "cli", provider: "openrouter" });
  });
});

test("registry: AGENT_ENGINE=cli forces rollback, AGENT_ENGINE=provider forces the engine", async () => {
  await withEnv("AGENT_ENGINE", "cli", async () => {
    assert.deepEqual(resolveEngine("gemini-2.5-flash"), { engine: "cli", provider: "gemini" });
  });
  await withEnv("AGENT_ENGINE", "provider", async () => {
    assert.deepEqual(resolveEngine("openrouter/free", { agentType: "cursor" }), { engine: "provider", provider: "openrouter" });
  });
});

test("registry: createProvider instantiates the three adapters", () => {
  const config = { apiKey: "fake-injected-key" } as const;
  const openrouter = createProvider("openrouter", config);
  const mistral = createProvider("mistral", config);
  const gemini = createProvider("gemini", config);
  assert.equal(openrouter.isConfigured(), true);
  assert.equal(mistral.isConfigured(), true);
  assert.equal(gemini.isConfigured(), true);
});

test("registry: createProviders returns one instance per provider id", () => {
  const providers = createProviders({ apiKey: "k" });
  assert.deepEqual(Object.keys(providers).sort(), ["gemini", "mistral", "openrouter"]);
  assert.equal(providers.gemini.id, "gemini");
  assert.equal(providers.mistral.id, "mistral");
  assert.equal(providers.openrouter.id, "openrouter");
});

test("registry: getProviderForModel returns provider + model (with default fallback)", () => {
  const providers = createProviders({ apiKey: "k" });
  const gemini = getProviderForModel("gemini-2.5-flash", providers);
  assert.equal(gemini.providerId, "gemini");
  assert.equal(gemini.model, "gemini-2.5-flash");
  const blank = getProviderForModel(null, providers);
  assert.equal(blank.providerId, "openrouter");
  assert.equal(blank.model, providers.openrouter.defaultModel);
});

test("registry: getProviderCatalog exposes metadata and configured flags, no secrets", () => {
  const empty = getProviderCatalog({});
  assert.equal(empty.length, 3);
  assert.equal(
    empty.every((p) => p.configured === false),
    true
  );
  const configured = getProviderCatalog({ apiKey: "k" });
  assert.equal(
    configured.every((p) => p.configured === true),
    true
  );
  assert.equal(configured[0].metadata.envVar, "OPENROUTER_API_KEY");
  const ids = configured.flatMap((p) => p.models.map((m) => m.id));
  assert.ok(ids.includes("openrouter/free"));
  assert.ok(ids.includes("mistral-large-latest"));
  assert.ok(ids.includes("gemini-3.5-flash-lite"));
});

test("registry: allModelIds unions every catalogue", () => {
  const ids = allModelIds();
  assert.ok(ids.includes("openrouter/free"));
  assert.ok(ids.includes("mistral-large-latest"));
  assert.ok(ids.includes("gemini-3.5-flash-lite"));
});