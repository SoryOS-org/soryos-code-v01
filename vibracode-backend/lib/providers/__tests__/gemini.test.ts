import { test } from "node:test";
import assert from "node:assert/strict";

import { GeminiProvider } from "../gemini";
import { sanitizeGeminiSchema } from "../gemini";
import { ChatMessage, StreamEvent } from "../types";
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

test("gemini: defaults to gemini-2.5-flash and is unconfigured without a key", async () => {
  await withEnv("GEMINI_DEFAULT_MODEL", "", async () => {
    const provider = new GeminiProvider({ apiKey: "k" });
    assert.equal(provider.defaultModel, "gemini-2.5-flash");
    assert.equal(provider.isConfigured(), true);
    assert.equal(new GeminiProvider({}).isConfigured(), false);
  });
});

test("gemini: sanitizeGeminiSchema uppercases type and drops unsupported keys", () => {
  const input = {
    type: "object",
    title: "T",
    $schema: "http://json-schema.org/",
    additionalProperties: false,
    properties: {
      path: { type: "string", title: "Path" },
      items: { type: "array", items: { type: "string" }, additionalProperties: true },
    },
    required: ["path"],
  } as const;
  const out = sanitizeGeminiSchema(input) as Record<string, unknown>;
  assert.equal(out["type"], "OBJECT");
  assert.equal(out["title"], undefined);
  assert.equal(out["$schema"], undefined);
  assert.equal(out["additionalProperties"], undefined);
  const properties = out["properties"] as Record<string, unknown>;
  assert.equal((properties["path"] as Record<string, unknown>)["type"], "STRING");
  assert.equal((properties["path"] as Record<string, unknown>)["title"], undefined);
  const items = (properties["items"] as Record<string, unknown>)["items"] as Record<string, unknown>;
  assert.equal(items["type"], "STRING");
});

test("gemini: chat() parses functionCall tool calls", async () => {
  const payload = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "run_command", args: { command: "npm run build" } } },
            { text: "running" },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    modelVersion: "gemini-2.5-flash",
  };
  const provider = new GeminiProvider({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  const result = await provider.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "build" }] });
  assert.equal(result.text, "running");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "run_command");
  assert.deepEqual(result.toolCalls[0].arguments, { command: "npm run build" });
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test("gemini: sends x-goog-api-key header and systemInstruction", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const provider = new GeminiProvider({
    apiKey: "k",
    fetchImpl: async (input, init) => {
      url = typeof input === "string" ? input : input.toString();
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body));
      return new Response('{"candidates":[]}', { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await provider.chat({
    model: "gemini-2.5-flash",
    messages: [{ role: "system", content: "be strict" }, { role: "user", content: "hi" }],
  });
  assert.match(url, /models\/gemini-2.5-flash:generateContent/);
  assert.equal(headers["x-goog-api-key"], "k");
  assert.deepEqual(body["systemInstruction"], { parts: [{ text: "be strict" }] });
  assert.equal(url.includes("?alt=sse"), false);
});

test("gemini: stream() uses SSE endpoint and groups consecutive tool responses", async () => {
  const chunks = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}' + "\n\n",
    'data: {"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}' + "\n\n",
    "data: [DONE]" + "\n\n",
  ].join("");

  const provider = new GeminiProvider({
    apiKey: "k",
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      assert.match(url, /:streamGenerateContent\?alt=sse/);
      return new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const events: StreamEvent[] = [];
  const result = await provider.stream(
    {
      model: "gemini-2.5-flash",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {}, argumentsRaw: "{}" }] },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "body" },
        { role: "user", content: "summarize" },
      ],
    },
    (event) => events.push(event)
  );
  assert.equal(result.text, "ok");
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  assert.ok(events.some((e) => e.type === "text-delta"));
});

test("gemini: 403 maps to a forbidden ProviderError with the real message", async () => {
  const provider = new GeminiProvider({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 403, message: "API key not valid" } }), { status: 403 }),
  });
  await provider.chat({ model: "gemini-2.5-flash", messages: [] }).then(
    () => assert.fail("should reject"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal((error as ProviderError).code, "forbidden");
      assert.equal((error as ProviderError).message, "API key not valid");
    }
  );
});

test("gemini: getCapabilities reflects the catalogue", () => {
  const provider = new GeminiProvider({ apiKey: "k" });
  assert.equal(provider.getCapabilities("gemini-2.5-flash").toolCalling, true);
});