#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import type { DoneMessage, Scale, Source } from '@agent-map/core';
import { Replay } from '@agent-map/server/replay';
import { fromArray, mergeSessions, openSession } from '@agent-map/server/sources';
const usage = 'agent-map run --source pi|copilot|trace --session <uuid|path> [--session …] [--out out] [--branches active|all] [--follow] [--id name] [--scale linear|log]';
function fail(error: unknown): never { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
async function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({ allowPositionals: true, options: {
      source: { type: 'string', default: 'pi' }, session: { type: 'string', multiple: true },
      out: { type: 'string', default: 'out' }, branches: { type: 'string', default: 'active' },
      follow: { type: 'boolean', default: false }, id: { type: 'string' }, scale: { type: 'string', default: 'linear' },
    } });
  } catch { console.error(usage); process.exit(2); }
  const f = args.values, sessions = (f.session ?? []) as string[], source = f.source as Source;
  const branches = f.branches as 'active' | 'all', scale = f.scale as Scale, follow = f.follow as boolean;
  if (args.positionals.length !== 1 || args.positionals[0] !== 'run' || !['pi','copilot','trace'].includes(source) || !['active','all'].includes(branches) || !['linear','log'].includes(scale) || !sessions.length || (follow && sessions.length !== 1)) {
    console.error(usage); process.exit(2);
  }
  const id = (f.id as string | undefined) ?? crypto.randomUUID();
  if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') { console.error('--id must be a filename, not a path'); process.exit(2); }
  const abort = new AbortController();
  const sources = await Promise.all(sessions.map(s => openSession(source, s, { branches, follow, signal: abort.signal })));
  const events = follow ? sources[0] : fromArray(await mergeSessions(sources));
  const replay = new Replay(id, events, { mode: 'fixed', speed: Infinity, outDir: f.out as string, scale }, abort);
  replay.on('done', ({ files }: DoneMessage) => { for (const file of files) console.log(file); process.exit(0); });
  replay.on('failure', fail);
  process.on('SIGINT', () => { void replay.stop().catch(fail); });
  replay.play();
}
main().catch(fail);
