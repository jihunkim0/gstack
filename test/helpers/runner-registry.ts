/**
 * Runner registry — maps runner names to adapter instances.
 *
 * Also provides CLI availability detection (checks if the binary is installed).
 */

import { spawnSync } from 'child_process';
import type { RunnerAdapter } from './runner-adapter';
import { ClaudeAdapter } from './claude-adapter';
import { GeminiAdapter } from './gemini-adapter';
import { OpenCodeAdapter } from './opencode-adapter';

const ADAPTERS: Record<string, RunnerAdapter> = {
  claude: new ClaudeAdapter(),
  gemini: new GeminiAdapter(),
  opencode: new OpenCodeAdapter(),
};

export type RunnerName = 'claude' | 'gemini' | 'opencode';
export const VALID_RUNNERS = Object.keys(ADAPTERS) as RunnerName[];

/** Get adapter by name. Throws if unknown. */
export function getAdapter(name: string): RunnerAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unknown runner '${name}'. Valid runners: ${VALID_RUNNERS.join(', ')}`);
  }
  return adapter;
}

/** Check if a runner's CLI binary is installed and accessible. */
export function isAvailable(name: string): boolean {
  const adapter = ADAPTERS[name];
  if (!adapter) return false;
  const binary = adapter.spawnCommand()[0];
  const result = spawnSync('which', [binary], { stdio: 'pipe', timeout: 3000 });
  return result.status === 0;
}

/** List all runners whose CLI binary is available. */
export function listAvailable(): RunnerName[] {
  return VALID_RUNNERS.filter(name => isAvailable(name));
}
