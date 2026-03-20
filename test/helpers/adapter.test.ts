import { describe, test, expect } from 'bun:test';
import { ClaudeAdapter } from './claude-adapter';
import { GeminiAdapter } from './gemini-adapter';
import { OpenCodeAdapter } from './opencode-adapter';
import { getAdapter, isAvailable, VALID_RUNNERS } from './runner-registry';
import { normalizeTool, TOOL_NAME_MAP } from './runner-adapter';

// --- Fixture data from confirmed CLI outputs (2026-03-19) ---

const CLAUDE_FIXTURE = [
  '{"type":"system","subtype":"init","session_id":"test-123"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"echo hello"}}]}}',
  '{"type":"user","tool_use_result":{"tool_use_id":"tu1","stdout":"hello\\n","stderr":""}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"The command printed hello."}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"Done.","num_turns":2,"total_cost_usd":0.04,"usage":{"input_tokens":1234,"output_tokens":56,"cache_read_input_tokens":789}}',
];

const GEMINI_FIXTURE = [
  '{"type":"init","session_id":"gem-123","model":"gemini-3.1-pro-preview-customtools"}',
  '{"type":"message","role":"user","content":"Run bash: echo hello\\n"}',
  '{"type":"message","role":"assistant","content":"I will execute the command.","delta":true}',
  '{"type":"tool_use","tool_name":"run_shell_command","tool_id":"abc","parameters":{"command":"echo hello","description":"Print hello"}}',
  '{"type":"tool_result","tool_id":"abc","status":"success","output":"hello"}',
  '{"type":"message","role":"assistant","content":" The command was executed successfully.","delta":true}',
  '{"type":"result","status":"success","stats":{"total_tokens":23602,"input_tokens":23306,"output_tokens":100,"cached":16247,"duration_ms":5122,"tool_calls":1,"models":{"gemini-3.1-pro-preview-customtools":{"total_tokens":21008}}}}',
];

const OPENCODE_FIXTURE = [
  '{"type":"step_start","sessionID":"ses_123","part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_123","part":{"type":"tool","tool":"bash","callID":"call1","state":{"status":"completed","input":{"command":"echo hello_from_opencode","description":"Print hello"},"output":"hello_from_opencode\\n","metadata":{"exit":0}}}}',
  '{"type":"step_finish","sessionID":"ses_123","part":{"type":"step-finish","reason":"tool-calls","cost":0.044392,"tokens":{"total":21526,"input":21392,"output":30,"reasoning":104,"cache":{"read":0,"write":0}}}}',
  '{"type":"text","sessionID":"ses_123","part":{"type":"text","text":"Here is the output of the command."}}',
  '{"type":"step_finish","sessionID":"ses_123","part":{"type":"step-finish","reason":"stop","cost":0.007313,"tokens":{"total":21673,"input":1222,"output":22,"reasoning":44,"cache":{"read":20385,"write":0}}}}',
];

// --- Claude Adapter ---

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();

  test('name is claude', () => {
    expect(adapter.name).toBe('claude');
  });

  test('spawnCommand returns ["claude"]', () => {
    expect(adapter.spawnCommand()).toEqual(['claude']);
  });

  test('spawnArgs includes required flags', () => {
    const args = adapter.spawnArgs({ maxTurns: 10, allowedTools: ['Bash', 'Read'] });
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--max-turns');
    expect(args).toContain('10');
    expect(args).toContain('--allowed-tools');
    expect(args).toContain('Bash');
    expect(args).toContain('Read');
  });

  test('spawnArgs omits maxTurns/allowedTools when not provided', () => {
    const args = adapter.spawnArgs({});
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--allowed-tools');
  });

  test('parseNDJSON extracts tool calls with normalized names', () => {
    const parsed = adapter.parseNDJSON(CLAUDE_FIXTURE);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].tool).toBe('Bash');
    expect(parsed.toolCalls[0].normalizedTool).toBe('bash');
    expect(parsed.toolCalls[0].input).toEqual({ command: 'echo hello' });
    expect(parsed.toolCallCount).toBe(1);
  });

  test('parseNDJSON extracts result line with cost and usage', () => {
    const parsed = adapter.parseNDJSON(CLAUDE_FIXTURE);
    expect(parsed.resultLine).not.toBeNull();
    expect(parsed.resultLine!.status).toBe('success');
    expect(parsed.resultLine!.isError).toBe(false);
    expect(parsed.resultLine!.output).toBe('Done.');
    expect(parsed.resultLine!.numTurns).toBe(2);
    expect(parsed.resultLine!.totalCostUsd).toBe(0.04);
    expect(parsed.resultLine!.usage.inputTokens).toBe(1234);
    expect(parsed.resultLine!.usage.outputTokens).toBe(56);
    expect(parsed.resultLine!.usage.cacheTokens).toBe(789);
  });

  test('parseNDJSON counts turns correctly', () => {
    const parsed = adapter.parseNDJSON(CLAUDE_FIXTURE);
    expect(parsed.turnCount).toBe(2); // 2 assistant events
  });

  test('parseNDJSON handles is_error result', () => {
    const lines = [
      '{"type":"result","subtype":"success","is_error":true,"result":"API error"}',
    ];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.resultLine!.status).toBe('error');
    expect(parsed.resultLine!.isError).toBe(true);
  });

  test('parseNDJSON handles empty input', () => {
    const parsed = adapter.parseNDJSON([]);
    expect(parsed.transcript).toHaveLength(0);
    expect(parsed.resultLine).toBeNull();
    expect(parsed.turnCount).toBe(0);
    expect(parsed.toolCalls).toHaveLength(0);
  });

  test('parseNDJSON skips malformed lines', () => {
    const lines = ['not json', '{"type":"result","subtype":"success","result":"ok"}'];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(1);
    expect(parsed.resultLine!.status).toBe('success');
  });
});

// --- Gemini Adapter ---

describe('GeminiAdapter', () => {
  const adapter = new GeminiAdapter();

  test('name is gemini', () => {
    expect(adapter.name).toBe('gemini');
  });

  test('spawnCommand returns ["gemini"]', () => {
    expect(adapter.spawnCommand()).toEqual(['gemini']);
  });

  test('spawnArgs includes model and stream-json flags', () => {
    const args = adapter.spawnArgs({});
    expect(args).toContain('--model');
    expect(args).toContain('-o');
    expect(args).toContain('stream-json');
    expect(args).toContain('-y');
  });

  test('spawnArgs ignores maxTurns and allowedTools', () => {
    const args = adapter.spawnArgs({ maxTurns: 10, allowedTools: ['Bash'] });
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--allowed-tools');
  });

  test('parseNDJSON extracts tool calls with normalized names', () => {
    const parsed = adapter.parseNDJSON(GEMINI_FIXTURE);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].tool).toBe('run_shell_command');
    expect(parsed.toolCalls[0].normalizedTool).toBe('bash');
    expect(parsed.toolCalls[0].input).toEqual({ command: 'echo hello', description: 'Print hello' });
  });

  test('parseNDJSON pairs tool_result output by tool_id', () => {
    const parsed = adapter.parseNDJSON(GEMINI_FIXTURE);
    expect(parsed.toolCalls[0].output).toBe('hello');
  });

  test('parseNDJSON concatenates assistant message chunks', () => {
    const parsed = adapter.parseNDJSON(GEMINI_FIXTURE);
    expect(parsed.resultLine!.output).toContain('I will execute the command.');
    expect(parsed.resultLine!.output).toContain('The command was executed successfully.');
  });

  test('parseNDJSON extracts token stats with no cost', () => {
    const parsed = adapter.parseNDJSON(GEMINI_FIXTURE);
    expect(parsed.resultLine!.totalCostUsd).toBe(0);
    expect(parsed.resultLine!.usage.inputTokens).toBe(23306);
    expect(parsed.resultLine!.usage.outputTokens).toBe(100);
    expect(parsed.resultLine!.usage.cacheTokens).toBe(16247);
  });

  test('parseNDJSON uses stats.tool_calls for turn count', () => {
    const parsed = adapter.parseNDJSON(GEMINI_FIXTURE);
    expect(parsed.turnCount).toBe(1); // stats.tool_calls = 1
  });

  test('parseNDJSON status from result event', () => {
    const parsed = adapter.parseNDJSON(GEMINI_FIXTURE);
    expect(parsed.resultLine!.status).toBe('success');
    expect(parsed.resultLine!.isError).toBe(false);
  });

  test('parseNDJSON handles empty input', () => {
    const parsed = adapter.parseNDJSON([]);
    expect(parsed.transcript).toHaveLength(0);
    expect(parsed.resultLine).toBeNull();
  });

  test('parseNDJSON handles missing tool_result for tool_use', () => {
    const lines = [
      '{"type":"tool_use","tool_name":"read_file","tool_id":"xyz","parameters":{"path":"/tmp/test"}}',
      '{"type":"result","status":"success","stats":{"total_tokens":100,"input_tokens":80,"output_tokens":20}}',
    ];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].output).toBe(''); // no matching tool_result
  });

  test('parseNDJSON skips malformed lines', () => {
    const lines = ['garbage', ...GEMINI_FIXTURE.slice(-1)];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(1);
  });
});

// --- OpenCode Adapter ---

describe('OpenCodeAdapter', () => {
  const adapter = new OpenCodeAdapter();

  test('name is opencode', () => {
    expect(adapter.name).toBe('opencode');
  });

  test('spawnCommand returns ["opencode"]', () => {
    expect(adapter.spawnCommand()).toEqual(['opencode']);
  });

  test('spawnArgs returns run --format json', () => {
    const args = adapter.spawnArgs({});
    expect(args).toEqual(['run', '--format', 'json']);
  });

  test('parseNDJSON extracts tool calls with inline output', () => {
    const parsed = adapter.parseNDJSON(OPENCODE_FIXTURE);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].tool).toBe('bash');
    expect(parsed.toolCalls[0].normalizedTool).toBe('bash');
    expect(parsed.toolCalls[0].input).toEqual({ command: 'echo hello_from_opencode', description: 'Print hello' });
    expect(parsed.toolCalls[0].output).toContain('hello_from_opencode');
  });

  test('parseNDJSON sums cost across step_finish events', () => {
    const parsed = adapter.parseNDJSON(OPENCODE_FIXTURE);
    expect(parsed.resultLine!.totalCostUsd).toBeCloseTo(0.051705, 5); // 0.044392 + 0.007313
  });

  test('parseNDJSON sums tokens across step_finish events', () => {
    const parsed = adapter.parseNDJSON(OPENCODE_FIXTURE);
    expect(parsed.resultLine!.usage.inputTokens).toBe(22614); // 21392 + 1222
    expect(parsed.resultLine!.usage.outputTokens).toBe(52);   // 30 + 22
    expect(parsed.resultLine!.usage.cacheTokens).toBe(20385);  // 0 + 20385
  });

  test('parseNDJSON counts step_finish events as turns', () => {
    const parsed = adapter.parseNDJSON(OPENCODE_FIXTURE);
    expect(parsed.turnCount).toBe(2);
  });

  test('parseNDJSON uses last step_finish.reason for success', () => {
    const parsed = adapter.parseNDJSON(OPENCODE_FIXTURE);
    expect(parsed.resultLine!.status).toBe('success');
    expect(parsed.resultLine!.isError).toBe(false);
  });

  test('parseNDJSON collects text parts', () => {
    const parsed = adapter.parseNDJSON(OPENCODE_FIXTURE);
    expect(parsed.resultLine!.output).toBe('Here is the output of the command.');
  });

  test('parseNDJSON handles step_finish with undefined cost', () => {
    const lines = [
      '{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"stop","tokens":{"input":100,"output":10}}}',
    ];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.resultLine!.totalCostUsd).toBe(0);
    expect(parsed.resultLine!.usage.inputTokens).toBe(100);
  });

  test('parseNDJSON handles empty input', () => {
    const parsed = adapter.parseNDJSON([]);
    expect(parsed.transcript).toHaveLength(0);
    expect(parsed.resultLine).toBeNull();
  });

  test('parseNDJSON handles non-stop last reason as error', () => {
    const lines = [
      '{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","reason":"tool-calls","cost":0.01,"tokens":{"input":100,"output":10}}}',
    ];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.resultLine!.status).toBe('tool-calls');
    expect(parsed.resultLine!.isError).toBe(true);
  });

  test('parseNDJSON skips malformed lines', () => {
    const lines = ['bad json', ...OPENCODE_FIXTURE.slice(-1)];
    const parsed = adapter.parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(1);
  });
});

// --- Runner Registry ---

describe('RunnerRegistry', () => {
  test('getAdapter returns correct adapter for known names', () => {
    expect(getAdapter('claude').name).toBe('claude');
    expect(getAdapter('gemini').name).toBe('gemini');
    expect(getAdapter('opencode').name).toBe('opencode');
  });

  test('getAdapter throws for unknown runner with valid names', () => {
    expect(() => getAdapter('unknown')).toThrow(/Unknown runner 'unknown'/);
    expect(() => getAdapter('unknown')).toThrow(/claude/);
    expect(() => getAdapter('unknown')).toThrow(/gemini/);
    expect(() => getAdapter('unknown')).toThrow(/opencode/);
  });

  test('VALID_RUNNERS contains all three', () => {
    expect(VALID_RUNNERS).toContain('claude');
    expect(VALID_RUNNERS).toContain('gemini');
    expect(VALID_RUNNERS).toContain('opencode');
  });
});

// --- Tool Name Normalization ---

describe('normalizeTool', () => {
  test('normalizes Claude tool names', () => {
    expect(normalizeTool('Bash')).toBe('bash');
    expect(normalizeTool('Read')).toBe('read');
    expect(normalizeTool('Write')).toBe('write');
    expect(normalizeTool('Edit')).toBe('edit');
    expect(normalizeTool('Glob')).toBe('glob');
    expect(normalizeTool('Grep')).toBe('grep');
  });

  test('normalizes Gemini tool names', () => {
    expect(normalizeTool('run_shell_command')).toBe('bash');
    expect(normalizeTool('read_file')).toBe('read');
    expect(normalizeTool('write_file')).toBe('write');
    expect(normalizeTool('edit_file')).toBe('edit');
  });

  test('OpenCode names are already canonical (lowercase passthrough)', () => {
    expect(normalizeTool('bash')).toBe('bash');
    expect(normalizeTool('read')).toBe('read');
    expect(normalizeTool('write')).toBe('write');
  });

  test('unknown tool names pass through lowercased', () => {
    expect(normalizeTool('CustomTool')).toBe('customtool');
    expect(normalizeTool('my_special_tool')).toBe('my_special_tool');
  });
});
