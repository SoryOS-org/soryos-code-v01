import { test } from "node:test";
import assert from "node:assert/strict";

import { MistralProvider, MISTRAL_MODELS } from "../mistral";
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

test("mistral: defaults to mistral-large-latest and official base URL", async () => {
  await withEnv("MISTRAL_DEFAULT_MODEL", "", async () => {
    const provider = new MistralProvider({ apiKey: "k" });
    assert.equal(provider.defaultModel, "mistral-large-latest");
    assert.equal(provider.isConfigured(), true);
  });
});

test("mistral: not configured without an API key", () => {
  const provider = new MistralProvider({});
  assert.equal(provider.isConfigured(), false);
});

test("mistral: catalogue includes tool-capable coding models", () => {
  const ids = MISTRAL_MODELS.map((m) => m.id);
  assert.ok(ids.includes("mistral-large-latest"));
  assert.ok(ids.includes("devstral-small-latest"));
  const nemo = MISTRAL_MODELS.find((m) => m.id === "open-mistral-nemo");
  assert.equal(nemo?.toolCalling, false);
});

test("mistral: does NOT send stream_options (Mistral returns usage in the body)", async () => {
  let captured: Record<string, unknown> | undefined;
  const sseBody = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}' + "\n\n",
    'data: [DONE]' + "\n\n",
  ].join("");
  const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    captured = JSON.parse(String(init?.body));
    assert.match(url, /chat\/completions$/);
    return new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });
  };
  const provider = new MistralProvider({ apiKey: "k", fetchImpl });
  const result = await provider.stream(
    { model: "devstral-small-latest", messages: [{ role: "user", content: "hi" }] },
    () => {}
  );
  assert.equal(result.text, "hi");
  assert.equal(captured?.["stream_options"], undefined);
  assert.equal(captured?.["stream"], true);
});

test("mistral: chat() honours a config base URL override", async () => {
  let url = "";
  const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
    url = typeof input === "string" ? input : input.toString();
    return new Response('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const provider = new MistralProvider({ apiKey: "k", baseUrl: "https://api.mistral.local/v1", fetchImpl });
  await provider.chat({ model: "mistral-medium-latest", messages: [{ role: "user", content: "hi" }] });
  assert.equal(url, "https://api.mistral.local/v1/chat/completions");
});

test("mistral: 401 maps to an unauthorized ProviderError", async () => {
  const fetchImpl: typeof fetch = async () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 });
  const provider = new MistralProvider({ apiKey: "bad", fetchImpl });
  await provider.chat({ model: "mistral-large-latest", messages: [] }).then(
    () => assert.fail("should reject"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal((error as ProviderError).code, "unauthorized");
      assert.equal((error as ProviderError).status, 401);
    }
  );
});