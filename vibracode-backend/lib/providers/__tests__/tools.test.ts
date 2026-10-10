import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENT_TOOLS } from "../tools";

test("tools: exposes the full agent tool set", () => {
  const names = new Set(AGENT_TOOLS.map((tool) => tool.name));
  assert.equal(names.size, AGENT_TOOLS.length, "tool names must be unique");
  for (const expected of [
    "read_file",
    "write_file",
    "edit_file",
    "delete_file",
    "list_dir",
    "run_command",
    "grep",
    "update_todos",
  ]) {
    assert.ok(names.has(expected), `missing tool ${expected}`);
  }
});

test("tools: every tool declares an object parameter schema", () => {
  for (const tool of AGENT_TOOLS) {
    assert.ok(tool.description.trim().length > 0, `${tool.name} needs a description`);
    assert.equal(tool.parameters.type, "object", `${tool.name} must use an object schema`);
    assert.ok(tool.parameters.properties, `${tool.name} must declare properties`);
    assert.ok(tool.parameters.required, `${tool.name} must declare required fields`);
  }
});

test("tools: fallback tools are excluded from tool_calling (read-only agent run)", () => {
  // The "tools" module intentionally has no fallback pseudo-tool — if a test
  // ever regresses and the loop silently loses tools, these guards catch it.
  const names = AGENT_TOOLS.map((tool) => tool.name);
  assert.ok(!names.includes("fallback"));
});