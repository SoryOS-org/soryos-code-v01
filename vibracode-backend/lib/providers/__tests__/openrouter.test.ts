import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenRouterProvider, OPENROUTER_MODELS } from "../openrouter";
import { ProviderError } from "../errors";

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

test("openrouter: defaults to north-mini-code when no env override is set", async () => {
  await withEnv("OPENROUTER_DEFAULT_MODEL", "", async () => {
    const provider = new OpenRouterProvider({ apiKey: "k" });
    assert.equal(provider.defaultModel, "cohere/north-mini-code:free");
    assert.equal(provider.isConfigured(), true);
  });
});

test("openrouter: honours OPENROUTER_DEFAULT_MODEL environment override", async () => {
  await withEnv("OPENROUTER_DEFAULT_MODEL", "thinkingmachines/inkling:free", async () => {
    const provider = new OpenRouterProvider({ apiKey: "k" });
    assert.equal(provider.defaultModel, "thinkingmachines/inkling:free");
  });
});

test("openrouter: curated catalogue is non-empty and includes the free router", () => {
  assert.ok(OPENROUTER_MODELS.length > 0);
  const ids = OPENROUTER_MODELS.map((m) => m.id);
  assert.ok(ids.includes("openrouter/free"));
});

test("openrouter: getCapabilities is unknown for the free router (verified at runtime)", () => {
  const provider = new OpenRouterProvider({ apiKey: "k" });
  assert.equal(provider.getCapabilities("openrouter/free").toolCalling, "unknown");
  assert.equal(provider.getCapabilities("cohere/north-mini-code:free").toolCalling, true);
});

test("openrouter: not configured without an API key", () => {
  const provider = new OpenRouterProvider({});
  assert.equal(provider.isConfigured(), false);
});

test("openrouter: assertToolSupport passes for the free router", () => {
  const provider = new OpenRouterProvider({ apiKey: "k" });
  assert.doesNotThrow(() => provider.assertToolSupport("openrouter/free"));
});

test("openrouter: hits the OpenRouter endpoint with attribution headers", async () => {
  await withEnv("OPENROUTER_BASE_URL", "", async () => {
    await withEnv("OPENROUTER_SITE_URL", "https://vibracode.app", async () => {
      await withEnv("OPENROUTER_APP_NAME", "Vibra Code", async () => {
        let url = "";
        let headers: Record<string, string> = {};
        const fetchImpl: typeof fetch = async (input, init) => {
          url = typeof input === "string" ? input : input.toString();
          headers = init?.headers as Record<string, string>;
          return new Response('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };
        const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
        await provider.chat({ model: "openrouter/free", messages: [{ role: "user", content: "hi" }] });
        assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
        assert.equal(headers["Authorization"], "Bearer k");
        assert.equal(headers["HTTP-Referer"], "https://vibracode.app");
        assert.equal(headers["X-Title"], "Vibra Code");
      });
    });
  });
});

test("openrouter: throws ProviderError with details on non-OK response", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: "dead" } }), { status: 500 });
  const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
  await provider.chat({ model: "openrouter/free", messages: [] }).then(
    () => assert.fail("should reject"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal((error as ProviderError).status, 500);
    }
  );
});