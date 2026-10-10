import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSSE, safeJsonParse, extractErrorMessage, resolveFetch } from "../http";

function sse(...chunks: string[]): Response {
  return new Response(chunks.join("\n"), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("http: parseSSE yields data payloads and stops at [DONE]", async () => {
  const body = [
    "data: {\"a\":1}\n\n",
    "data: {\"b\":2}\n\n",
    "data: [DONE]\n\n",
    "data: this-should-be-ignored\n\n",
  ].join("");
  const events: string[] = [];
  for await (const data of parseSSE(new Response(body))) events.push(data);
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
});

test("http: parseSSE joins multi-line data payloads with newlines (SSE spec)", async () => {
  const body = "data: {\"a\":\ndata: 1,\ndata: \"b\"}\n\n";
  const events: string[] = [];
  for await (const data of parseSSE(new Response(body))) events.push(data);
  // SSE concatenates consecutive `data:` lines with "\n" exactly as sent.
  assert.deepEqual(events, ['{"a":\n1,\n"b"}']);
});

test("http: parseSSE handles events split across stream chunks", async () => {
  // First chunk ends mid-event, second chunk completes it.
  const body = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"x":'));
        controller.enqueue(enc.encode('123}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    })
  );
  const events: string[] = [];
  for await (const data of parseSSE(body)) events.push(data);
  assert.deepEqual(events, ['{"x":123}']);
});

test("http: safeJsonParse returns undefined on garbage", () => {
  assert.deepEqual(safeJsonParse('{"k":1}'), { k: 1 });
  assert.equal(safeJsonParse("not json"), undefined);
});

test("http: extractErrorMessage reads OpenAI and Google error shapes", () => {
  assert.equal(extractErrorMessage('{"error":{"message":"boom"}}'), "boom");
  assert.equal(extractErrorMessage('{"error":"plain"}'), "plain");
  assert.equal(extractErrorMessage('{"error":{"message":"gcloud"}}'), "gcloud");
  assert.equal(extractErrorMessage("raw text"), "raw text");
});

test("http: resolveFetch prefers injected fetch", () => {
  const injected = async () => new Response();
  const config = { fetchImpl: injected as unknown as typeof fetch };
  assert.equal(resolveFetch(config), injected);
});