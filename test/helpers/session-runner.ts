/**
 * Multi-CLI subprocess runner for skill E2E testing.
 *
 * Spawns a CLI process (Claude, Gemini, or OpenCode) via RunnerAdapter,
 * pipes prompt via stdin, streams NDJSON output for real-time progress,
 * and scans for browse errors.
 *
 *   runSkillTest({ runner: 'claude' })  ──► ClaudeAdapter
 *   runSkillTest({ runner: 'gemini' })  ──► GeminiAdapter
 *   runSkillTest({ runner: 'opencode' }) ──► OpenCodeAdapter
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAdapter } from './runner-registry';
import type { RunnerAdapter, ParsedNDJSON as AdapterParsedNDJSON } from './runner-adapter';

const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, 'e2e-live.json');

/** Sanitize test name for use as filename: strip leading slashes, replace / with - */
export function sanitizeTestName(name: string): string {
  return name.replace(/^\/+/, '').replace(/\//g, '-');
}

/** Atomic write: write to .tmp then rename. Non-fatal on error. */
function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export interface CostEstimate {
  inputChars: number;
  outputChars: number;
  estimatedTokens: number;
  estimatedCost: number;  // USD
  turnsUsed: number;
}

export interface SkillTestResult {
  toolCalls: Array<{ tool: string; input: any; output: string }>;
  browseErrors: string[];
  exitReason: string;
  duration: number;
  output: string;
  costEstimate: CostEstimate;
  transcript: any[];
  runner: string;
}

const BROWSE_ERROR_PATTERNS = [
  /Unknown command: \w+/,
  /Unknown snapshot flag: .+/,
  /ERROR: browse binary not found/,
  /Server failed to start/,
  /no such file or directory.*browse/i,
];

// --- Legacy parseNDJSON export (Claude-only, for backward compat with existing tests) ---

export interface ParsedNDJSON {
  transcript: any[];
  resultLine: any | null;
  turnCount: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; input: any; output: string }>;
}

/**
 * Parse Claude NDJSON lines. Kept for backward compatibility with
 * session-runner.test.ts. New code should use adapter.parseNDJSON().
 */
export function parseNDJSON(lines: string[]): ParsedNDJSON {
  const transcript: any[] = [];
  let resultLine: any = null;
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
              input: item.input || {},
              output: '',
            });
          }
        }
      }

      if (event.type === 'result') resultLine = event;
    } catch { /* skip malformed lines */ }
  }

  return { transcript, resultLine, turnCount, toolCallCount, toolCalls };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Extract tool name from a streaming NDJSON event (CLI-agnostic).
 * Used for real-time progress display before full parseNDJSON runs.
 */
function extractToolFromEvent(event: any): { name: string; input: any } | null {
  // Claude: type:"assistant" → message.content[].type:"tool_use"
  if (event.type === 'assistant') {
    const content = event.message?.content || [];
    for (const item of content) {
      if (item.type === 'tool_use') {
        return { name: item.name || 'unknown', input: item.input || {} };
      }
    }
  }
  // Gemini: type:"tool_use" → tool_name
  if (event.type === 'tool_use' && event.tool_name) {
    return { name: event.tool_name, input: event.parameters || {} };
  }
  // OpenCode: type:"tool_use" → part.tool
  if (event.type === 'tool_use' && event.part?.tool) {
    return { name: event.part.tool, input: event.part.state?.input || {} };
  }
  return null;
}

// --- Main runner ---

export async function runSkillTest(options: {
  prompt: string;
  workingDirectory: string;
  runner?: 'claude' | 'gemini' | 'opencode';
  maxTurns?: number;
  allowedTools?: string[];
  timeout?: number;
  testName?: string;
  runId?: string;
}): Promise<SkillTestResult> {
  const {
    prompt,
    workingDirectory,
    runner = 'claude',
    maxTurns = 15,
    allowedTools = ['Bash', 'Read', 'Write'],
    timeout = 120_000,
    testName,
    runId,
  } = options;

  const adapter = getAdapter(runner);
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // Set up per-run log directory if runId is provided
  let runDir: string | null = null;
  const safeName = testName ? sanitizeTestName(testName) : null;
  if (runId) {
    try {
      runDir = path.join(GSTACK_DEV_DIR, 'e2e-runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch { /* non-fatal */ }
  }

  // Build spawn command via adapter (array-based, no shell)
  const spawnCmd = [
    ...adapter.spawnCommand(),
    ...adapter.spawnArgs({ maxTurns, allowedTools }),
  ];

  // Spawn process with stdin pipe — prompt delivered via stdin
  const proc = Bun.spawn(spawnCmd, {
    cwd: workingDirectory,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Write prompt to stdin and close
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Race against timeout
  let stderr = '';
  let exitReason = 'unknown';
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  // Stream NDJSON from stdout for real-time progress
  const collectedLines: string[] = [];
  let liveTurnCount = 0;
  let liveToolCount = 0;
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        // Real-time progress (CLI-agnostic tool extraction)
        try {
          const event = JSON.parse(line);
          const tool = extractToolFromEvent(event);
          if (tool) {
            liveToolCount++;
            if (event.type === 'assistant') liveTurnCount++;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const progressLine = `  [${elapsed}s] ${runner} turn ${liveTurnCount} tool #${liveToolCount}: ${tool.name}(${truncate(JSON.stringify(tool.input), 80)})\n`;
            process.stderr.write(progressLine);

            // Persist progress.log
            if (runDir) {
              try { fs.appendFileSync(path.join(runDir, 'progress.log'), progressLine); } catch { /* non-fatal */ }
            }

            // Write heartbeat (atomic)
            if (runId && testName) {
              try {
                const toolDesc = `${tool.name}(${truncate(JSON.stringify(tool.input), 60)})`;
                atomicWriteSync(HEARTBEAT_PATH, JSON.stringify({
                  runId,
                  runner,
                  pid: proc.pid,
                  startedAt,
                  currentTest: testName,
                  status: 'running',
                  turn: liveTurnCount,
                  toolCount: liveToolCount,
                  lastTool: toolDesc,
                  lastToolAt: new Date().toISOString(),
                  elapsedSec: elapsed,
                }, null, 2) + '\n');
              } catch { /* non-fatal */ }
            }
          }
        } catch { /* skip — adapter.parseNDJSON will handle it later */ }

        // Append raw NDJSON line to per-test transcript file
        if (runDir && safeName) {
          try { fs.appendFileSync(path.join(runDir, `${safeName}.ndjson`), line + '\n'); } catch { /* non-fatal */ }
        }
      }
    }
  } catch { /* stream read error — fall through to exit code handling */ }

  // Flush remaining buffer
  if (buf.trim()) {
    collectedLines.push(buf);
  }

  stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  if (timedOut) {
    exitReason = 'timeout';
  } else if (exitCode === 0) {
    exitReason = 'success';
  } else {
    exitReason = `exit_code_${exitCode}`;
  }

  const duration = Date.now() - startTime;

  // Parse all collected NDJSON lines via adapter
  const parsed = adapter.parseNDJSON(collectedLines);
  const { transcript, resultLine, toolCalls: adapterToolCalls } = parsed;
  const browseErrors: string[] = [];

  // Scan transcript + stderr for browse errors
  const allText = transcript.map(e => JSON.stringify(e)).join('\n') + '\n' + stderr;
  for (const pattern of BROWSE_ERROR_PATTERNS) {
    const match = allText.match(pattern);
    if (match) {
      browseErrors.push(match[0].slice(0, 200));
    }
  }

  // Use normalized result for exit reason
  if (resultLine) {
    if (resultLine.isError) {
      exitReason = resultLine.status === 'error' ? 'error_api' : resultLine.status;
    } else if (resultLine.status === 'success') {
      exitReason = 'success';
    } else if (resultLine.status) {
      exitReason = resultLine.status;
    }
  }

  // Save failure transcript
  if (browseErrors.length > 0 || exitReason !== 'success') {
    try {
      const failureDir = runDir || path.join(workingDirectory, '.gstack', 'test-transcripts');
      fs.mkdirSync(failureDir, { recursive: true });
      const failureName = safeName
        ? `${safeName}-failure.json`
        : `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(
        path.join(failureDir, failureName),
        JSON.stringify({
          prompt: prompt.slice(0, 500),
          testName: testName || 'unknown',
          runner,
          exitReason,
          browseErrors,
          duration,
          turnAtTimeout: timedOut ? liveTurnCount : undefined,
          lastToolCall: liveToolCount > 0 ? `tool #${liveToolCount}` : undefined,
          stderr: stderr.slice(0, 2000),
          result: resultLine ? { status: resultLine.status, output: resultLine.output?.slice?.(0, 500) } : null,
        }, null, 2),
      );
    } catch { /* non-fatal */ }
  }

  // Cost from adapter's normalized result
  const turnsUsed = resultLine?.numTurns || 0;
  const estimatedCost = resultLine?.totalCostUsd || 0;
  const inputChars = prompt.length;
  const outputChars = (resultLine?.output || '').length;
  const estimatedTokens = resultLine
    ? (resultLine.usage.inputTokens + resultLine.usage.outputTokens + resultLine.usage.cacheTokens)
    : 0;

  const costEstimate: CostEstimate = {
    inputChars,
    outputChars,
    estimatedTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    turnsUsed,
  };

  // Map adapter toolCalls to legacy format (drop normalizedTool for compat)
  const toolCalls = adapterToolCalls.map(tc => ({
    tool: tc.tool,
    input: tc.input,
    output: tc.output,
  }));

  return { toolCalls, browseErrors, exitReason, duration, output: resultLine?.output || '', costEstimate, transcript, runner };
}
