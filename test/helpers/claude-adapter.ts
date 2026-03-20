/**
 * Claude Code stream-json adapter.
 *
 * Extracts the existing parseNDJSON logic from session-runner.ts.
 * Claude NDJSON schema:
 *   type:"assistant" → message.content[].type:"tool_use" → {name, input}
 *   type:"result"    → {subtype, is_error, result, num_turns, total_cost_usd, usage}
 */

import type { RunnerAdapter, SpawnOptions, ParsedNDJSON, NormalizedResult } from './runner-adapter';
import { normalizeTool } from './runner-adapter';

export class ClaudeAdapter implements RunnerAdapter {
  name = 'claude';

  spawnCommand(): string[] {
    return ['claude'];
  }

  spawnArgs(opts: SpawnOptions): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];
    if (opts.maxTurns != null) {
      args.push('--max-turns', String(opts.maxTurns));
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowed-tools', ...opts.allowedTools);
    }
    return args;
  }

  parseNDJSON(lines: string[]): ParsedNDJSON {
    const transcript: any[] = [];
    let resultLine: NormalizedResult | null = null;
    let turnCount = 0;
    let toolCallCount = 0;
    const toolCalls: ParsedNDJSON['toolCalls'] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        transcript.push(event);

        if (event.type === 'assistant') {
          turnCount++;
          const content = event.message?.content || [];
          for (const item of content) {
            if (item.type === 'tool_use') {
              toolCallCount++;
              toolCalls.push({
                tool: item.name || 'unknown',
                normalizedTool: normalizeTool(item.name || 'unknown'),
                input: item.input || {},
                output: '',
              });
            }
          }
        }

        if (event.type === 'result') {
          const isError = !!event.is_error;
          let status: string;
          if (isError) {
            status = 'error';
          } else if (event.subtype === 'success') {
            status = 'success';
          } else {
            status = event.subtype || 'unknown';
          }

          resultLine = {
            status,
            output: event.result || '',
            isError,
            numTurns: event.num_turns || 0,
            totalCostUsd: event.total_cost_usd || 0,
            usage: {
              inputTokens: event.usage?.input_tokens || 0,
              outputTokens: event.usage?.output_tokens || 0,
              cacheTokens: event.usage?.cache_read_input_tokens || 0,
            },
          };
        }
      } catch { /* skip malformed lines */ }
    }

    return { transcript, resultLine, turnCount, toolCallCount, toolCalls };
  }
}
