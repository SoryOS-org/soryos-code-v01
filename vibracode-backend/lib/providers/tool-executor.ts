/**
 * Executes agent tool calls against an isolated E2B sandbox.
 *
 * This module is deliberately independent from any AI provider: it only depends
 * on a minimal `SandboxLike` interface so it can be unit-tested with a fake and
 * swapped for the real `@e2b/code-interpreter` Sandbox at runtime.
 *
 * Safety: every path is constrained to the project root (`/vibe0`) and a small
 * denylist prevents commands that would destroy the sandbox or the project.
 */

import { ToolCall, ToolDefinition } from "./types";
import { AGENT_TOOLS } from "./tools";

export const PROJECT_ROOT = "/vibe0";
const MAX_READ_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxFileEntry {
  name: string;
  type?: string;
  path?: string;
  isDir?: boolean;
}

/** Minimal subset of the E2B Sandbox API the executor relies on. */
export interface SandboxLike {
  files: {
    read(path: string): Promise<string | Uint8Array>;
    write(path: string, content: string): Promise<unknown>;
    list(path: string): Promise<SandboxFileEntry[]>;
    remove(path: string): Promise<unknown>;
  };
  commands: {
    run(
      command: string,
      options?: { cwd?: string; timeoutMs?: number }
    ): Promise<SandboxCommandResult>;
  };
}

export interface ExecutedToolResult {
  id: string;
  name: string;
  /** String content returned to the model. */
  content: string;
  isError: boolean;
  /** Structured payload the engine maps onto the existing Convex message fields. */
  data?: Record<string, unknown>;
}

export interface ToolExecutor {
  listTools(): ToolDefinition[];
  execute(call: ToolCall, signal?: AbortSignal): Promise<ExecutedToolResult>;
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/** Normalise and constrain a path to the project root. */
export function resolveProjectPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new ToolExecutionError("A file path is required.");
  }
  if (input.includes("\0")) {
    throw new ToolExecutionError("Invalid path.");
  }
  const absolute = input.startsWith("/") ? input : `${PROJECT_ROOT}/${input}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const resolved = `/${parts.join("/")}`;
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(`${PROJECT_ROOT}/`)) {
    throw new ToolExecutionError(`Path escapes the project root: ${input}`);
  }
  return resolved;
}

const COMMAND_DENYLIST: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, reason: "fork bombs are not allowed" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "filesystem formatting is not allowed" },
  { pattern: /\bdd\b[^\n]*of=\/dev\//, reason: "raw device writes are not allowed" },
  { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/, reason: "shutdown commands are not allowed" },
  { pattern: /\brm\s+(-[a-zA-Z]+\s+)*\/\s*$/, reason: "deleting the filesystem root is not allowed" },
  { pattern: /\brm\s+(-[a-zA-Z]+\s+)*\/vibe0\/?\s*$/, reason: "deleting the project root is not allowed" },
  { pattern: /\bchmod\s+-R\s+[0-7]{3,4}\s+\/(\s|$)/, reason: "recursive chmod on root is not allowed" },
];

export function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const trimmed = (command || "").trim();
  if (!trimmed) return { allowed: false, reason: "Empty command" };
  for (const rule of COMMAND_DENYLIST) {
    if (rule.pattern.test(trimmed)) {
      return { allowed: false, reason: rule.reason };
    }
  }
  return { allowed: true };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const omitted = value.length - max;
  return `${value.slice(0, max)}\n… [truncated ${omitted} chars]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/**
 * E2B-backed tool executor.
 */
export class E2BToolExecutor implements ToolExecutor {
  constructor(private readonly sandbox: SandboxLike) {}

  listTools(): ToolDefinition[] {
    return AGENT_TOOLS;
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ExecutedToolResult> {
    if (signal?.aborted) {
      return { id: call.id, name: call.name, content: "Agent stopped by user", isError: true, data: { message: "Agent stopped by user" } };
    }
    try {
      switch (call.name) {
        case "read_file":
          return await this.readFile(call);
        case "write_file":
          return await this.writeFile(call);
        case "edit_file":
          return await this.editFile(call);
        case "delete_file":
          return await this.deleteFile(call);
        case "list_dir":
          return await this.listDir(call);
        case "run_command":
          return await this.runCommand(call);
        case "grep":
          return await this.grep(call);
        case "update_todos":
          return this.updateTodos(call);
        default:
          return this.fail(call, `Unknown tool: ${call.name}`);
      }
    } catch (error: any) {
      return this.fail(call, error?.message ?? "Tool execution failed");
    }
  }

  private async readFile(call: ToolCall): Promise<ExecutedToolResult> {
    const path = resolveProjectPath(asString(call.arguments.path));
    const raw = await this.sandbox.files.read(path);
    const content = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return this.ok(call, truncate(content, MAX_READ_CHARS), { read: { filePath: path } });
  }

  private async writeFile(call: ToolCall): Promise<ExecutedToolResult> {
    const path = resolveProjectPath(asString(call.arguments.path));
    const content = asString(call.arguments.content);
    await this.writeWithParents(path, content);
    return this.ok(
      call,
      `Wrote ${content.length} bytes to ${path}`,
      { edit: { filePath: path, oldString: "", newString: content } }
    );
  }

  private async editFile(call: ToolCall): Promise<ExecutedToolResult> {
    const path = resolveProjectPath(asString(call.arguments.path));
    const oldString = asString(call.arguments.old_string);
    const newString = asString(call.arguments.new_string);
    if (!oldString) {
      return this.fail(call, "old_string must not be empty. Use write_file to create or replace a whole file.");
    }
    const raw = await this.sandbox.files.read(path);
    const current = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const firstIndex = current.indexOf(oldString);
    if (firstIndex === -1) {
      return this.fail(call, `old_string was not found in ${path}. Read the file again and retry.`);
    }
    const lastIndex = current.lastIndexOf(oldString);
    if (firstIndex !== lastIndex) {
      return this.fail(call, `old_string appears more than once in ${path}. Provide more surrounding context.`);
    }
    const updated = current.slice(0, firstIndex) + newString + current.slice(firstIndex + oldString.length);
    await this.writeWithParents(path, updated);
    return this.ok(
      call,
      `Edited ${path}`,
      { edit: { filePath: path, oldString, newString, replacements: 1 } }
    );
  }

  private async deleteFile(call: ToolCall): Promise<ExecutedToolResult> {
    const path = resolveProjectPath(asString(call.arguments.path));
    await this.sandbox.files.remove(path);
    return this.ok(
      call,
      `Deleted ${path}`,
      { tool: { toolName: "delete", command: `rm ${path}`, output: "File deleted", exitCode: 0, status: "success" } }
    );
  }

  private async listDir(call: ToolCall): Promise<ExecutedToolResult> {
    const requested = asString(call.arguments.path) || PROJECT_ROOT;
    const path = resolveProjectPath(requested);
    const entries = await this.sandbox.files.list(path);
    const lines = entries
      .map((entry) => {
        const isDir = entry.isDir ?? (entry.type === "dir" || entry.type === "directory");
        const name = entry.name || (entry.path ? entry.path.split("/").pop() : "") || "";
        return `${isDir ? "dir" : "file"} ${name}`;
      })
      .sort()
      .join("\n");
    return this.ok(call, lines || "(empty directory)", {
      bash: { command: `ls ${path}`, output: lines, exitCode: 0 },
    });
  }

  private async runCommand(call: ToolCall): Promise<ExecutedToolResult> {
    const command = asString(call.arguments.command).trim();
    const policy = isCommandAllowed(command);
    if (!policy.allowed) {
      return this.fail(call, `Command refused: ${policy.reason}`);
    }
    const cwdArg = asString(call.arguments.cwd);
    const cwd = cwdArg ? resolveProjectPath(cwdArg) : PROJECT_ROOT;
    const result = await this.sandbox.commands.run(command, { cwd, timeoutMs: 600_000 });
    const output = truncate(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, MAX_OUTPUT_CHARS);
    const isError = result.exitCode !== 0;
    const content = `exit code: ${result.exitCode}\n${output || "(no output)"}`;
    const data = {
      bash: { command, output: output || result.stderr || "", exitCode: result.exitCode },
    };
    const executed = this.ok(call, content, data);
    executed.isError = isError;
    return executed;
  }

  private async grep(call: ToolCall): Promise<ExecutedToolResult> {
    const pattern = asString(call.arguments.pattern);
    if (!pattern) return this.fail(call, "pattern is required.");
    const requested = asString(call.arguments.path) || PROJECT_ROOT;
    const path = resolveProjectPath(requested);
    const include = asString(call.arguments.include);
    const includeFlag = include ? `--include=${shellQuote(include)} ` : "";
    const command = `grep -rn --color=never ${includeFlag}-- ${shellQuote(pattern)} ${shellQuote(path)} | head -n 200`;
    const result = await this.sandbox.commands.run(command, { cwd: PROJECT_ROOT, timeoutMs: 120_000 });
    const output = truncate(result.stdout || result.stderr, MAX_OUTPUT_CHARS);
    const matches = output.split("\n").filter((line) => line.trim().length > 0);
    return this.ok(call, output || "(no matches)", {
      grep: { pattern, filePath: path, matches, lineCount: matches.length },
    });
  }

  private updateTodos(call: ToolCall): ExecutedToolResult {
    const raw = call.arguments.todos;
    const list = Array.isArray(raw) ? raw : [];
    const todos = list.map((todo: any, index: number) => ({
      id: asString(todo?.id) || `todo-${index + 1}`,
      content: asString(todo?.content),
      status: ["pending", "in_progress", "completed"].includes(todo?.status) ? todo.status : "pending",
      priority: asString(todo?.priority) || "medium",
    }));
    return this.ok(call, `Updated task list (${todos.length} items)`, { todos });
  }

  private async writeWithParents(path: string, content: string): Promise<void> {
    try {
      await this.sandbox.files.write(path, content);
    } catch {
      const parent = path.slice(0, path.lastIndexOf("/")) || PROJECT_ROOT;
      await this.sandbox.commands.run(`mkdir -p ${shellQuote(parent)}`, { cwd: PROJECT_ROOT });
      await this.sandbox.files.write(path, content);
    }
  }

  private ok(call: ToolCall, content: string, data?: Record<string, unknown>): ExecutedToolResult {
    return { id: call.id, name: call.name, content, isError: false, data };
  }

  private fail(call: ToolCall, content: string): ExecutedToolResult {
    return { id: call.id, name: call.name, content, isError: true };
  }
}
