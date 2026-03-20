/**
 * Gemini CLI stream-json adapter.
 *
 * Gemini NDJSON schema (confirmed 2026-03-19):
 *   type:"tool_use"    → {tool_name, tool_id, parameters}
 *   type:"tool_result" → {tool_id, status, output}
 *   type:"message" + role:"assistant" → text chunks (delta:true)
 *   type:"result"  → {status, stats.{total_tokens, input_tokens, output_tokens, cached, tool_calls}}
 */

import type { RunnerAdapter, SpawnOptions, ParsedNDJSON, NormalizedResult } from './runner-adapter';
import { normalizeTool } from './runner-adapter';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview-customtools';

export class GeminiAdapter implements RunnerAdapter {
  name = 'gemini';

  spawnCommand(): string[] {
    return ['gemini'];
  }

  spawnArgs(_opts: SpawnOptions): string[] {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    return ['--model', model, '-o', 'stream-json', '-y'];
    // Note: Gemini has no --max-turns or --allowed-tools equivalents
  }

  parseNDJSON(lines: string[]): ParsedNDJSON {
    const transcript: any[] = [];
    let turnCount = 0;
    let toolCallCount = 0;
    const toolCalls: ParsedNDJSON['toolCalls'] = [];
    const assistantChunks: string[] = [];

    // Pending tool calls indexed by tool_id for pairing with tool_result
    const pendingTools = new Map<string, { tool: string; normalizedTool: string; input: any }>();

    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheTokens = 0;
    let resultStatus = '';
    let statsToolCalls = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        transcript.push(event);

        if (event.type === 'tool_use') {
          toolCallCount++;
          const toolName = event.tool_name || 'unknown';
          const entry = {
            tool: toolName,
            normalizedTool: normalizeTool(toolName),
            input: event.parameters || {},
            output: '',
          };
          toolCalls.push(entry);
          if (event.tool_id) {
            pendingTools.set(event.tool_id, entry);
          }
        }

        if (event.type === 'tool_result' && event.tool_id) {
          const pending = pendingTools.get(event.tool_id);
          if (pending) {
            // Find the matching toolCall and set its output
            const match = toolCalls.find(tc => tc === pending);
            if (match) {
              match.output = event.output || '';
            }
          }
          turnCount++;
        }

        if (event.type === 'message' && event.role === 'assistant') {
          if (event.content) {
            assistantChunks.push(event.content);
          }
        }

        if (event.type === 'result') {
          resultStatus = event.status || 'unknown';
          if (event.stats) {
            totalTokens = event.stats.total_tokens || 0;
            inputTokens = event.stats.input_tokens || 0;
            outputTokens = event.stats.output_tokens || 0;
            cacheTokens = event.stats.cached || 0;
            statsToolCalls = event.stats.tool_calls || 0;
          }
        }
      } catch { /* skip malformed lines */ }
    }

    // Turn count: use stats.tool_calls as proxy if available, else count tool_result events
    const finalTurnCount = statsToolCalls || turnCount;

    const resultLine: NormalizedResult | null = resultStatus ? {
      status: resultStatus === 'success' ? 'success' : resultStatus,
      output: assistantChunks.join(''),
      isError: resultStatus !== 'success',
      numTurns: finalTurnCount,
      totalCostUsd: 0, // Gemini does not provide USD cost
      usage: {
        inputTokens,
        outputTokens,
        cacheTokens,
      },
    } : null;

    return { transcript, resultLine, turnCount: finalTurnCount, toolCallCount, toolCalls };
  }
}
