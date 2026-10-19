import { createReadStream, existsSync } from 'node:fs';
import { stat, watch } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { FileEvent, SessionInfo, Source } from '@agent-map/core';
import { linesOf, parseCopilot, parsePi, parseTrace } from '@agent-map/core/parsers';
export const PI_DIR = process.env.PI_SESSIONS_DIR ?? join(homedir(), '.pi/agent/sessions');
export const COPILOT_DIR = process.env.COPILOT_SESSIONS_DIR ?? join(homedir(), '.copilot/session-state');
export async function discover(source?: Source, repo?: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  for (const src of ['pi', 'copilot'] as const) {
    if (source && source !== src) continue;
    const dir = src === 'pi' ? PI_DIR : COPILOT_DIR;
    try {
      await stat(dir);
      for (const pattern of src === 'pi' ? ['*/*.jsonl'] : ['*/events.jsonl', '*.jsonl']) {
        for await (const rel of new Bun.Glob(pattern).scan(dir)) {
          const path = resolve(dir, rel);
          try {
            let id: string, cwd = '';
            if (src === 'pi') {
              const header = JSON.parse((await Bun.file(path).slice(0, 4096).text()).split('\n')[0]);
              if (header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') continue;
              id = header.id; cwd = header.cwd;
            } else {
              id = basename(path) === 'events.jsonl' ? basename(dirname(path)) : basename(path, '.jsonl');
              let n = 0;
              const input = createReadStream(path);
              const lines = createInterface({ input, crlfDelay: Infinity });
              try {
                for await (const line of lines) {
                  try { const e = JSON.parse(line); if (e?.type === 'session.start') { cwd = typeof e.data?.context?.cwd === 'string' ? e.data.context.cwd : ''; break; } } catch {}
                  if (++n >= 20) break;
                }
              } finally { lines.close(); input.destroy(); }
            }
            sessions.push({ id: `${src}:${id}`, source: src, repo: cwd, path, modified: (await stat(path)).mtimeMs });
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
        }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return sessions.filter(s => !repo || s.repo === repo || s.repo.startsWith(repo + '/')).sort((a, b) => b.modified - a.modified);
}
export async function* readLines(path: string, follow: boolean, signal?: AbortSignal): AsyncIterable<string> {
  if (!follow) { yield* linesOf(await Bun.file(path).text()); return; }
  if (signal?.aborted) return;
  let offset = 0, rest = '';
  const decoder = new TextDecoder();
  async function* drain() {
    const bytes = await Bun.file(path).slice(offset).arrayBuffer();
    offset += bytes.byteLength;
    const parts = (rest + decoder.decode(bytes, { stream: true })).split('\n');
    rest = parts.pop()!;
    for (const line of parts) if (line.trim()) yield line;
  }
  // ponytail: fs.watch; if WSL inotify misses writes, replace the watch loop with a 500 ms stat-size poll.
  const changes = watch(path, { signal });
  try {
    yield* drain();
    for await (const _ of changes) { if (signal?.aborted) return; yield* drain(); }
  } catch (e) { if ((e as Error).name !== 'AbortError') throw e; }
  finally { await changes.return?.(); }
}
export async function openSession(source: Source, ref: string, opts: { branches: 'active' | 'all'; follow: boolean; signal?: AbortSignal }): Promise<AsyncIterable<FileEvent>> {
  const path = existsSync(ref) ? ref : (await discover(source)).find(s => s.id === `${source}:${ref}`)?.path;
  if (!path) throw Error(`session not found: ${source}:${ref}`);
  const lines = readLines(path, opts.follow, opts.signal);
  if (source === 'pi') return parsePi(lines, { branches: opts.branches, stream: opts.follow });
  if (source === 'copilot') return parseCopilot(lines, basename(path) === 'events.jsonl' ? basename(dirname(path)) : basename(path, '.jsonl'));
  return parseTrace(lines, basename(path));
}
export async function mergeSessions(sources: AsyncIterable<FileEvent>[]): Promise<FileEvent[]> {
  const groups = await Promise.all(sources.map(async source => { const events: FileEvent[] = []; for await (const e of source) events.push(e); return events; }));
  return groups.flat().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0) || a.seq - b.seq);
}
export async function* fromArray<T>(a: T[]): AsyncIterable<T> { yield* a; }
