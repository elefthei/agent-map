import { afterAll, expect, test } from 'bun:test';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, toMermaid, type FileEvent, type View } from '@agent-map/core';
import type { Replay } from '../src/replay';
const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
process.env.PI_SESSIONS_DIR = join(fixtures, 'pi');
process.env.COPILOT_SESSIONS_DIR = join(fixtures, 'copilot');
process.env.OMP_SESSIONS_DIR = join(fixtures, 'omp');
const { createApp } = await import('../src/app');
const { adaptorFor, linesOf, readLines } = await import('@agent-map/log-adaptors');
const outDir = await mkdtemp(join(tmpdir(), 'am-'));
const replays = new Map<string, Replay>(), app = createApp(replays, outDir);
const B = 'pi:11111111-1111-4111-8111-111111111111';
const C = 'copilot:2f0b1c3e-0000-4000-8000-000000000001';
const active: FileEvent[] = [];
for await (const e of adaptorFor('pi')!.parse(linesOf(await Bun.file(join(fixtures, 'pi/--home-user-repo--/2026-10-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl')).text()), { session: '11111111-1111-4111-8111-111111111111', branches: 'active', stream: false })) active.push(e);
const expected = (k: number, v: View) => toMermaid(active.slice(0, k).reduce((s,e) => reduce(s,e).state, initialState()), v);
const post = (p: string, body: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const path = (id: string) => `/api/replays/${id}`;
const control = (id: string, body: unknown) => post(path(id) + '/control', body);
async function loaded(r: Replay) { while (!r.ended) await once(r, 'progress'); }
async function create(options = {}) {
  const res = await post('/api/replays', { sessionIds: [B], mode: 'step', ...options });
  expect(res.status).toBe(201);
  const snap = await res.json(), replay = replays.get(snap.id)!;
  await loaded(replay);
  return { snap, replay, id: snap.id as string };
}
afterAll(async () => { await Promise.all([...replays.values()].map(r => r.stop())); await rm(outDir, { recursive: true, force: true }); });
test('session discovery, sources and repository filter', async () => {
  const sources = await app.request('/api/sources'); expect(sources.status).toBe(200);
  expect(await sources.json()).toEqual([
    { source: 'pi', label: 'Pi agent', dir: join(fixtures, 'pi') },
    { source: 'copilot', label: 'Copilot CLI', dir: join(fixtures, 'copilot') },
    { source: 'omp', label: 'OMP', dir: join(fixtures, 'omp') },
  ]);
  expect(await (await app.request('/api/sessions?source=omp')).json()).toEqual([expect.objectContaining({ id: 'omp:01a10000-0000-7000-8000-000000000001', repo: '/home/user/repo' })]);
  const pi = await app.request('/api/sessions?source=pi'); expect(pi.status).toBe(200);
  expect(await pi.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: B, repo: '/home/user/repo' }), expect.objectContaining({ id: 'pi:01a0f2df-4b2f-75bd-8355-e950fa6b5bcf' })]));
  expect(await (await app.request('/api/sessions?source=copilot')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: C })]));
  expect(await (await app.request('/api/sessions?source=pi&repo=/nope')).json()).toEqual([]);
  expect((await app.request('/api/sessions?source=trace')).status).toBe(400);
});
test('OMP replay retains selector reads and multi-file hashline writes', async () => {
  const { replay } = await create({ sessionIds: ['omp:01a10000-0000-7000-8000-000000000001'] });
  expect(replay.events.length).toBe(4);
  replay.seek(4);
  expect(Object.keys(replay.state.writes.nodes).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  expect(replay.state.reads.nodes).toEqual({ 'src/a.ts': 1 });
});
test('step twice, reject unfinished Mermaid, stop and persist event-prefix output', async () => {
  const { snap, replay, id } = await create(); expect(snap.status).toBe('created'); expect(replay.events.length).toBe(3);
  for (let i=1; i<=2; i++) expect((await (await control(id, { action: 'step' })).json()).cursor).toBe(i);
  expect((await app.request(path(id) + '/mermaid?view=reads')).status).toBe(409);
  expect((await (await control(id, { action: 'stop' })).json()).status).toBe('stopped');
  expect(await (await app.request(path(id) + '/mermaid?view=reads')).text()).toBe(expected(2, 'reads'));
  expect(await Bun.file(join(outDir, id + '.reads.mmd')).text()).toBe(expected(2, 'reads'));
  expect((await control(id, { action: 'play' })).status).toBe(409);
});
test('seek and step reach identical Mermaid at the same cursor', async () => {
  const { id } = await create();
  expect((await (await control(id, { action: 'seek', to: 2 })).json()).cursor).toBe(2);
  await control(id, { action: 'stop' });
  for (const v of ['reads', 'writes'] as View[]) expect(await (await app.request(path(id) + '/mermaid?view=' + v)).text()).toBe(expected(2, v));
});
test('full playback completes and emits both deterministic views', async () => {
  const { replay, id } = await create({ mode: 'fixed', speed: 1e9 });
  const done = once(replay, 'done'); await control(id, { action: 'play' }); await done;
  expect(replay.status).toBe('completed'); expect(replay.cursor).toBe(3);
  for (const v of ['reads', 'writes'] as View[]) expect(replay.mermaid![v]).toBe(expected(3, v));
  expect(replay.mermaid!.writes).not.toContain('n0');
});
test('merged sessions sort by timestamp without cross-session transitions', async () => {
  const { replay } = await create({ sessionIds: [C, B] });
  expect(replay.events.map(e => e.origin)).toEqual(['pi','pi','pi','copilot','copilot','copilot']);
  expect(replay.events.length).toBe(6);
  replay.seek(6);
  expect(Object.keys(replay.state.reads.edges).sort()).toEqual(['src/a.ts\nsrc/b.ts','src/b.ts\nsrc/c.ts']);
});
test('SSE begins with snapshot, streams diffs and closes on done', async () => {
  const { replay, id } = await create();
  const res = await app.request(path(id) + '/events'), reader = res.body!.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value); expect(first.startsWith('event: snapshot')).toBe(true);
  const rest = (async () => { let text = ''; for (;;) { const r = await reader.read(); if (r.done) return text; text += decoder.decode(r.value); } })();
  await control(id, { action: 'step' }); await control(id, { action: 'stop' });
  const text = await rest; expect(text).toContain('event: diff'); expect(text).toContain('"seq":1'); expect(text).toContain('event: done');
  expect(replay.listenerCount('diff')).toBe(0);
  const ended = await (await app.request(path(id) + '/events')).text(); expect(ended).toMatch(/^event: snapshot/); expect(ended).toContain('event: done');
});
test('SSE reader cancellation removes listeners', async () => {
  const { replay, id } = await create();
  const res = await app.request(path(id) + '/events'), reader = res.body!.getReader();
  await reader.read(); await reader.cancel(); await Bun.sleep(5);
  expect(replay.listenerCount('diff')).toBe(0);
});
test('validation rejects malformed requests and unknown sessions', async () => {
  expect((await post('/api/replays', { sessionIds: [] })).status).toBe(400);
  expect((await post('/api/replays', { sessionIds: ['pi:missing'] })).status).toBe(404);
  expect((await post('/api/replays', { sessionIds: [B,C], follow: true })).status).toBe(400);
  const { id } = await create();
  expect((await control(id, { action: 'seek' })).status).toBe(400);
  expect((await control(id, { action: 'play', speed: 0 })).status).toBe(400);
  expect((await app.request(path(id) + '/mermaid?view=other')).status).toBe(400);
  expect((await app.request('/api/replays/missing')).status).toBe(404);
});
test('pause during a delay and immediate resume never runs two playback loops', async () => {
  const { replay } = await create({ mode: 'fixed', speed: 50 });
  replay.play(); replay.pause(); replay.play();
  await once(replay, 'diff'); replay.pause();
  const cursor = replay.cursor; await Bun.sleep(50); expect(replay.cursor).toBe(cursor);
  replay.step(); expect(replay.cursor).toBe(cursor + 1); await replay.stop();
});
test('follow preserves partial lines and split UTF-8 bytes, then aborts cleanly', async () => {
  const p = join(outDir, 'live.jsonl'), abort = new AbortController();
  await Bun.write(p, 'one\n');
  const it = readLines(p, true, abort.signal)[Symbol.asyncIterator](); expect((await it.next()).value).toBe('one');
  const pending = it.next(), bytes = Buffer.from('é\n');
  await appendFile(p, bytes.subarray(0,1)); await Bun.sleep(10); await appendFile(p, bytes.subarray(1));
  expect((await pending).value).toBe('é');
  const end = it.next(); abort.abort(); expect((await end).done).toBe(true);
});
