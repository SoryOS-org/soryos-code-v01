import { test } from "node:test";
import assert from "node:assert/strict";

import {
  E2BToolExecutor,
  isCommandAllowed,
  resolveProjectPath,
  SandboxLike,
} from "../tool-executor";
import { ToolCall } from "../types";

interface FakeFile {
  content: string;
}

const longContent = "a".repeat(100_000);

function makeSandbox(initial?: Record<string, string>): {
  sandbox: SandboxLike;
  files: Map<string, FakeFile>;
  commands: string[];
} {
  const files = new Map<string, FakeFile>();
  for (const [path, content] of Object.entries(initial ?? {})) {
    files.set(path, { content });
  }
  const commands: string[] = [];
  const sandbox: SandboxLike = {
    files: {
      async read(path) {
        const entry = files.get(path);
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return entry.content;
      },
      async write(path, content) {
        files.set(path, { content });
      },
      async list(path) {
        const prefix = path.endsWith("/") ? path : path + "/";
        const seen = new Map<string, string>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (!segment) continue;
          if (!seen.has(segment)) seen.set(segment, rest.includes("/") ? "dir" : "file");
        }
        return [...seen.entries()].map(([name, type]) => ({ name, type }));
      },
      async remove(path) {
        files.delete(path);
      },
    },
    commands: {
      async run(command, options) {
        commands.push(command);
        if (command.startsWith("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error("unexpected command: " + command);
      },
    },
  };
  return { sandbox, files, commands };
}

function call(name: string, args: Record<string, unknown>, id = "call-1"): ToolCall {
  return { id, name, arguments: args, argumentsRaw: JSON.stringify(args) };
}

test("tool-executor: read_file resolves relative paths and truncates", async () => {
  const { sandbox, files } = makeSandbox({ "/vibe0/src/app.ts": longContent });
  files.set("/vibe0/src/app.ts", { content: longContent });
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(call("read_file", { path: "src/app.ts" }));
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("[truncated"));
  assert.ok(result.content.length < 100_000);
  assert.deepEqual(result.data, { read: { filePath: "/vibe0/src/app.ts" } });
});

test("tool-executor: write_file creates files with parent dirs", async () => {
  const { sandbox, files } = makeSandbox({});
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(call("write_file", { path: "/vibe0/deep/nested/file.txt", content: "abc" }));
  assert.equal(result.isError, false);
  assert.equal(files.get("/vibe0/deep/nested/file.txt")?.content, "abc");
  const editData = result.data?.edit as Record<string, unknown> | undefined;
  assert.equal(editData?.filePath, "/vibe0/deep/nested/file.txt");
});

test("tool-executor: edit_file replaces the unique old_string", async () => {
  const { sandbox, files } = makeSandbox({ "/vibe0/a.txt": "hello world" });
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(
    call("edit_file", { path: "/vibe0/a.txt", old_string: "world", new_string: "moon" })
  );
  assert.equal(result.isError, false);
  assert.equal(files.get("/vibe0/a.txt")?.content, "hello moon");
  assert.equal((result.data?.edit as any).replacements, 1);
});

test("tool-executor: edit_file fails on missing or ambiguous matches", async () => {
  const { sandbox } = makeSandbox({ "/vibe0/a.txt": "one two one" });
  const executor = new E2BToolExecutor(sandbox);
  const missing = await executor.execute(
    call("edit_file", { path: "/vibe0/a.txt", old_string: "zzz", new_string: "y" })
  );
  assert.equal(missing.isError, true);
  const ambiguous = await executor.execute(
    call("edit_file", { path: "/vibe0/a.txt", old_string: "one", new_string: "two" })
  );
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content, /more than once/);
});

test("tool-executor: list_dir returns sorted entries", async () => {
  const { sandbox } = makeSandbox({ "/vibe0/b.txt": "", "/vibe0/a.ts": "", "/vibe0/src/x.ts": "" });
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(call("list_dir", { path: "/vibe0" }));
  assert.equal(result.isError, false);
  const lines = result.content.split("\n");
  assert.equal(lines[0], "dir src");
  assert.ok(lines.includes("file a.ts"));
  assert.ok(lines.includes("file b.txt"));
});

test("tool-executor: run_command executes and marks errors", async () => {
  const sandbox: SandboxLike = {
    files: {
      async read() {
        throw new Error("read");
      },
      async write() {},
      async list() {
        return [];
      },
      async remove() {},
    },
    commands: {
      async run(command, options) {
        assert.equal(options?.cwd, "/vibe0");
        if (command.includes("fail")) return { stdout: "", stderr: "boom", exitCode: 1 };
        return { stdout: "done\n", stderr: "", exitCode: 0 };
      },
    },
  };
  const executor = new E2BToolExecutor(sandbox);
  const ok = await executor.execute(call("run_command", { command: "npm test" }));
  assert.equal(ok.isError, false);
  assert.equal(ok.content, "exit code: 0\ndone\n");
  const bad = await executor.execute(call("run_command", { command: "make fail" }));
  assert.equal(bad.isError, true);
  assert.equal((bad.data?.bash as any).exitCode, 1);
});

test("tool-executor: run_command is denied by the safety denylist", async () => {
  const sandbox: SandboxLike = {
    files: {
      async read() {
        throw new Error("read");
      },
      async write() {},
      async list() {
        return [];
      },
      async remove() {},
    },
    commands: { async run() {
      return { stdout: "", stderr: "never called", exitCode: 0 };
    } },
  };
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(
    call("run_command", { command: "rm -rf /vibe0; :(){ :|:& };:" })
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /refused/);
});

test("tool-executor: isCommandAllowed blocks destructive commands", () => {
  for (const bad of [
    ":(){ :|:& };:",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown -h now",
    "sudo reboot",
    "rm -rf /",
    "rm -f /",
    "rm -rf /vibe0",
    "chmod -R 777 /",
  ]) {
    assert.equal(isCommandAllowed(bad).allowed, false, `should block: ${bad}`);
  }
  assert.equal(isCommandAllowed("rm -rf ./dist").allowed, true);
  assert.equal(isCommandAllowed("npm install").allowed, true);
});

test("tool-executor: resolveProjectPath confines paths to the project root", () => {
  assert.equal(resolveProjectPath("/vibe0/a/b.ts"), "/vibe0/a/b.ts");
  assert.equal(resolveProjectPath("a/b.ts"), "/vibe0/a/b.ts");
  assert.equal(resolveProjectPath("/vibe0/a/../b.ts"), "/vibe0/b.ts");
  assert.throws(() => resolveProjectPath("../../etc/passwd"), /escapes the project root/);
  assert.throws(() => resolveProjectPath(""), /is required/);
  assert.throws(() => resolveProjectPath("/etc/passwd"), /escapes the project root/);
  assert.throws(() => resolveProjectPath("/vibe0/../secret"), /escapes the project root/);
  assert.throws(() => resolveProjectPath("a\0b"), /Invalid path/);
});

test("tool-executor: update_todos normalises entries", async () => {
  const { sandbox } = makeSandbox();
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(
    call("update_todos", {
      todos: [
        { content: "Fix bug", status: "in_progress" },
        { content: "Done thing", status: "completed" },
        { content: "", status: "bogus" },
      ],
    })
  );
  assert.equal(result.isError, false);
  assert.equal((result.data?.todos as any[]).length, 3);
  assert.equal((result.data?.todos as any[])[2].status, "pending");
});

test("tool-executor: unknown tools fail gracefully", async () => {
  const { sandbox } = makeSandbox();
  const executor = new E2BToolExecutor(sandbox);
  const result = await executor.execute(call("rm_rf", {}));
  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown tool/);
});