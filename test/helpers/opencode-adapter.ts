/**
 * OpenCode CLI stream-json adapter.
 *
 * OpenCode NDJSON schema (confirmed 2026-03-19):
 *   type:"tool_use"    → part.{tool, state.{input, output, status}}
 *   type:"text"        → part.text
 *   type:"step_finish" → part.{reason, cost, tokens.{total, input, output, reasoning, cache.{read, write}}}
 *   type:"step_start"  → (ignored)
 *
 * Cost is per-step — adapter sums all step_finish.cost values.
 * Tokens are per-step — adapter sums all step_finish.tokens values.
 * Success = last step_finish.reason === "stop"
 */

import type { RunnerAdapter, SpawnOptions, ParsedNDJSON, NormalizedResult } from './runner-adapter';
import { normalizeTool } from './runner-adapter';

export class OpenCodeAdapter implements RunnerAdapter {
  name = 'opencode';

  spawnCommand(): string[] {
    return ['opencode'];
  }

  spawnArgs(_opts: SpawnOptions): string[] {
    return ['run', '--format', 'json'];
    // Note: OpenCode has no --max-turns or --allowed-tools equivalents
  }

  parseNDJSON(lines: string[]): ParsedNDJSON {
    const transcript: any[] = [];
    let toolCallCount = 0;
    const toolCalls: ParsedNDJSON['toolCalls'] = [];
    const textParts: string[] = [];

    // Accumulators for step_finish summation
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;
    let stepFinishCount = 0;
    let lastStepReason = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        transcript.push(event);

        if (event.type === 'tool_use' && event.part) {
          toolCallCount++;
          const toolName = event.part.tool || 'unknown';
          toolCalls.push({
            tool: toolName,
            normalizedTool: normalizeTool(toolName),
            input: event.part.state?.input || {},
            output: event.part.state?.output || '',
          });
        }

        if (event.type === 'text' && event.part) {
          if (event.part.text) {
            textParts.push(event.part.text);
          }
        }

        if (event.type === 'step_finish' && event.part) {
          stepFinishCount++;
          lastStepReason = event.part.reason || '';
          totalCost += event.part.cost || 0;

          const tokens = event.part.tokens;
          if (tokens) {
            totalInputTokens += tokens.input || 0;
            totalOutputTokens += tokens.output || 0;
            totalCacheTokens += (tokens.cache?.read || 0);
          }
        }
      } catch { /* skip malformed lines */ }
    }

    const status = lastStepReason === 'stop' ? 'success' : (lastStepReason || 'unknown');

    const resultLine: NormalizedResult | null = stepFinishCount > 0 ? {
      status,
      output: textParts.join(''),
      isError: status !== 'success',
      numTurns: stepFinishCount,
      totalCostUsd: Math.round(totalCost * 1000000) / 1000000, // preserve precision
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheTokens: totalCacheTokens,
      },
    } : null;

    return { transcript, resultLine, turnCount: stepFinishCount, toolCallCount, toolCalls };
  }
}
