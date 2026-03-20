/**
 * RunnerAdapter interface for multi-CLI eval support.
 *
 * Each adapter encapsulates how to spawn a CLI and parse its NDJSON output.
 * The session-runner delegates to the adapter for CLI-specific behavior.
 *
 *   session-runner.ts (shared: spawn, stream, timeout, heartbeat)
 *          │
 *          ▼
 *   runner-registry.ts ──► RunnerAdapter
 *          ├──► claude-adapter.ts
 *          ├──► gemini-adapter.ts
 *          └──► opencode-adapter.ts
 */

export interface RunnerAdapter {
  name: string;

  /** CLI binary name, e.g. ['claude'], ['gemini'], ['opencode'] */
  spawnCommand(): string[];

  /** CLI-specific flags for permissions, model, output format, etc. */
  spawnArgs(opts: SpawnOptions): string[];

  /** Parse CLI-specific NDJSON lines into normalized transcript. */
  parseNDJSON(lines: string[]): ParsedNDJSON;
}

export interface SpawnOptions {
  maxTurns?: number;       // Claude only — Gemini/OpenCode ignore
  allowedTools?: string[]; // Claude only — Gemini/OpenCode ignore
}

export interface ParsedNDJSON {
  transcript: any[];
  resultLine: NormalizedResult | null;
  turnCount: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; normalizedTool: string; input: any; output: string }>;
}

export interface NormalizedResult {
  status: 'success' | 'error' | string;
  output: string;
  isError: boolean;
  numTurns: number;
  totalCostUsd: number;   // 0 for Gemini (no cost data)
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
  };
}

/**
 * Tool name normalization map.
 *
 * Claude, Gemini, and OpenCode use different names for the same tools.
 * This map normalizes to lowercase canonical names for cross-CLI comparison.
 *
 *   Claude: Bash, Read, Write, Edit, Glob, Grep
 *   Gemini: run_shell_command, read_file, write_file, edit_file, glob, grep
 *   OpenCode: bash, read, write, edit, glob, grep
 */
export const TOOL_NAME_MAP: Record<string, string> = {
  // Claude → canonical
  'Bash': 'bash',
  'Read': 'read',
  'Write': 'write',
  'Edit': 'edit',
  'Glob': 'glob',
  'Grep': 'grep',
  'Agent': 'agent',
  'AskUserQuestion': 'ask_user',

  // Gemini → canonical
  'run_shell_command': 'bash',
  'read_file': 'read',
  'write_file': 'write',
  'edit_file': 'edit',

  // OpenCode already uses lowercase (identity mappings not needed)
};

/** Normalize a tool name to its canonical form. Unknown names pass through. */
export function normalizeTool(name: string): string {
  return TOOL_NAME_MAP[name] || name.toLowerCase();
}
