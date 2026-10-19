import { existsSync } from 'node:fs';
import { stat, watch } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FileEvent, SessionInfo, Source } from '@agent-map/core';
import { pi } from './pi';
import { copilot } from './copilot';
import { omp } from './omp';
import { trace } from './trace';
import { linesOf } from './rules';
import type { SessionLogParser } from './types';
export * from './types';
export * from './rules';
export const adaptors: readonly SessionLogParser[] = [pi, copilot, omp, trace];
export const adaptorFor = (source: string) => adaptors.find(a => a.source === source);
export async function discover(source?: Source, repo?: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  for (const a of adaptors) {
    if (!a.dir || (source && source !== a.source)) continue;
    const dir = a.dir;
    try { await stat(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    for (const pattern of a.patterns) {
      for await (const rel of new Bun.Glob(pattern).scan(dir)) {
        const path = resolve(dir, rel);
        try {
          const info = await a.describe(path);
          if (info) sessions.push({ id: `${a.source}:${info.id}`, source: a.source, repo: info.repo, path, modified: (await stat(path)).mtimeMs });
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    }
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
  const adaptor = adaptorFor(source);
  if (!adaptor) throw Error(`unknown source: ${source}`);
  const path = existsSync(ref) ? ref : (await discover(source)).find(s => s.id === `${source}:${ref}`)?.path;
  if (!path) throw Error(`session not found: ${source}:${ref}`);
  const info = await adaptor.describe(path);
  if (!info) throw Error('not a session file');
  return adaptor.parse(readLines(path, opts.follow, opts.signal), { session: info.id, branches: opts.branches, stream: opts.follow });
}
export async function mergeSessions(sources: AsyncIterable<FileEvent>[]): Promise<FileEvent[]> {
  const groups = await Promise.all(sources.map(async source => { const events: FileEvent[] = []; for await (const e of source) events.push(e); return events; }));
  return groups.flat().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0) || a.seq - b.seq);
}
export async function* fromArray<T>(a: T[]): AsyncIterable<T> { yield* a; }
