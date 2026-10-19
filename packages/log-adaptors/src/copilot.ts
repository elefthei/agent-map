import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import copilotRules from '../rules/copilot.json';
import { fileLike, matchRule, normalizePath, rulePaths, type Rules } from './rules';
import type { SessionLogParser } from './types';
const Envelope = z.object({ type: z.string(), timestamp: z.string().optional(), data: z.unknown() }).passthrough();
const StartData = z.object({ context: z.object({ cwd: z.string() }).passthrough().optional() }).passthrough();
const ToolStart = z.object({ toolName: z.string(), arguments: z.unknown().optional() }).passthrough();
export const copilot: SessionLogParser = {
  source: 'copilot', label: 'Copilot CLI',
  dir: process.env.COPILOT_SESSIONS_DIR ?? join(homedir(), '.copilot/session-state'),
  patterns: ['*/events.jsonl', '*.jsonl'],
  async describe(path) {
    const id = basename(path) === 'events.jsonl' ? basename(dirname(path)) : basename(path, '.jsonl');
    let cwd = '', n = 0;
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try { const e = JSON.parse(line); if (e?.type === 'session.start') { cwd = typeof e.data?.context?.cwd === 'string' ? e.data.context.cwd : ''; break; } } catch {}
        if (++n >= 20) break;
      }
    } finally { lines.close(); input.destroy(); }
    return { id, repo: cwd };
  },
  async *parse(lines, opts) {
    let cwd = '', seq = 0;
    for await (const line of lines) {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const result = Envelope.safeParse(raw);
      if (!result.success) continue;
      const e = result.data;
      if (e.type === 'session.start') { const start = StartData.safeParse(e.data); if (start.success) cwd = start.data.context?.cwd ?? ''; }
      if (e.type !== 'tool.execution_start') continue;
      const start = ToolStart.safeParse(e.data);
      if (!start.success) continue;
      const rule = matchRule(copilotRules as Rules, start.data.toolName);
      if (!rule) continue;
      for (const path of rulePaths(rule, start.data.arguments)) {
        if (!fileLike(path)) continue;
        yield { session: opts.session, seq: seq++, ts: e.timestamp ? Date.parse(e.timestamp) : undefined, op: rule.op, path: normalizePath(path, cwd), tool: start.data.toolName, origin: 'copilot' };
      }
    }
  },
};
