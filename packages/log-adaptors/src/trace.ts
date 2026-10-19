import { basename } from 'node:path';
import { fileLike } from './rules';
import type { SessionLogParser } from './types';
export const trace: SessionLogParser = {
  source: 'trace', label: 'Trace JSONL', patterns: [],
  describe: async path => ({ id: basename(path), repo: '' }),
  async *parse(lines, opts) {
    let seq = 0;
    for await (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || (o.op !== 'read' && o.op !== 'write') || typeof o.path !== 'string' || !fileLike(o.path)) continue;
      yield { session: opts.session, seq: seq++, ts: typeof o.ts === 'number' ? o.ts : undefined, op: o.op, path: o.path, tool: typeof o.tool === 'string' ? o.tool : 'trace', origin: 'trace' };
    }
  },
};
