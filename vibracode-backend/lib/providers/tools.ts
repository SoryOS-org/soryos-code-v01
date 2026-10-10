/**
 * Standard agent tool set. These are provider-agnostic definitions; the actual
 * execution happens against the E2B sandbox in `tool-executor.ts`.
 *
 * The tools deliberately mirror what the previous Claude Code CLI could do
 * (read/edit/write/bash/grep/todos) so the generated app experience is
 * preserved.
 */

import { ToolDefinition } from "./types";

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the full contents of a text file in the project. Use this before editing a file so you know the current content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or project-relative file path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file or overwrite an existing file with the given content. Use for new files or full rewrites.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write." },
        content: { type: "string", description: "Complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in an existing file. `old_string` must match exactly once. Prefer this over write_file for small changes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit." },
        old_string: { type: "string", description: "Exact text to replace (unique in the file)." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the project.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to delete." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory in the project.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path. Defaults to the project root." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project working directory. Use it to install packages, run builds/tests, or inspect the project. Returns stdout, stderr and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        cwd: { type: "string", description: "Optional working directory (relative to project root)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description:
      "Search for a regular expression across the project files. Returns matching lines with file names and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Optional directory or file to search. Defaults to project root." },
        include: { type: "string", description: "Optional glob filter, e.g. \"*.tsx\"." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "update_todos",
    description:
      "Record or update the task list shown to the user. Use it to break down complex work. Replaces the whole list.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full todo list.",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content"],
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
];

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);
