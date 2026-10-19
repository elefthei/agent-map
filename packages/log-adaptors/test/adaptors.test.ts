import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileEvent, Source } from '@agent-map/core';
const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
process.env.PI_SESSIONS_DIR = join(fixtures, 'pi');
process.env.COPILOT_SESSIONS_DIR = join(fixtures, 'copilot');
process.env.OMP_SESSIONS_DIR = join(fixtures, 'omp');
const { adaptorFor, discover, fileLike, linesOf, matchRule, normalizePath, openSession, pointerGet, rulePaths } = await import('../src');
const { treeDescribe } = await import('../src/tree');
const { stripSelector } = await import('../src/omp');
const piId = '11111111-1111-4111-8111-111111111111', ompId = '01a10000-0000-7000-8000-000000000001';
const branches = 'pi/--home-user-repo--/2026-10-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl';
const ompPath = join(fixtures, 'omp/-repo/2026-10-03T12-00-00-000Z_' + ompId + '.jsonl');
const fixture = async (p: string) => linesOf(await Bun.file(join(fixtures, p)).text());
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const e of it) out.push(e); return out; }
test('Pi real session and active/all branches', async () => {
  const pi = adaptorFor('pi')!, opts = { session: piId, branches: 'active' as const, stream: false };
  const real = await collect(pi.parse(await fixture('pi/--home-user-repo--/2026-09-30T15-11-55-183Z_01a0f2df-4b2f-75bd-8355-e950fa6b5bcf.jsonl'), { ...opts, session: '01a0f2df-4b2f-75bd-8355-e950fa6b5bcf' }));
  expect(real.map(({ op, path, tool, seq }) => ({ op, path, tool, seq }))).toEqual([0,1].map(seq => ({ op: 'read', path: 'test.txt', tool: 'read', seq })));
  const active = await collect(pi.parse(await fixture(branches), opts));
  expect(active.map(e => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  expect(active.every(e => e.op === 'read')).toBe(true);
  expect([...new Set(active.map(e => e.session))]).toEqual([piId]);
  const all = await collect(pi.parse(await fixture(branches), { ...opts, branches: 'all' }));
  expect(all.filter(e => e.session === piId + '#e5').map(e => [e.op, e.path, e.seq])).toEqual([['read','src/a.ts',0],['read','src/b.ts',1],['write','src/b.ts',2],['read','src/a.ts',3],['write','src/a.ts',4]]);
  expect(all.filter(e => e.session === piId + '#e6').map(e => e.path)).toEqual(active.map(e => e.path));
  const stream = await collect(pi.parse(await fixture(branches), { ...opts, session: 'override', stream: true }));
  expect(stream.map(e => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/b.ts', 'src/a.ts', 'src/a.ts', 'src/c.ts']);
  expect(stream.map(e => e.seq)).toEqual([0,1,2,3,4,5]);
  expect(stream.every(e => e.session === 'override')).toBe(true);
});
test('Copilot and raw trace parsers', async () => {
  const opts = { session: 'copilot-fixture', branches: 'active' as const, stream: false };
  const copilot = await collect(adaptorFor('copilot')!.parse(await fixture('copilot/2f0b1c3e-0000-4000-8000-000000000001/events.jsonl'), opts));
  expect(copilot.map(e => [e.tool, e.path, e.op])).toEqual([['view','src/a.ts','read'],['edit','src/b.ts','write'],['view','src/b.ts','read']]);
  const trace = await collect(adaptorFor('trace')!.parse(await fixture('trace/sample.jsonl'), { ...opts, session: 'trace' }));
  expect(trace.map(e => [e.op, e.path])).toEqual([['read','src/a.ts'],['write','src/a.ts']]);
  expect(trace[1].ts).toBe(1700000000000);
});
test('rules, pointers, normalization and malformed input', async () => {
  const r = { op: 'read' as const, path: '/path' }, opts = { session: 's', branches: 'active' as const, stream: false };
  expect(matchRule({ 'mcp__fs__*': r }, 'mcp__fs__read')).toBe(r);
  expect(pointerGet({ a: { 'b/c': 1 } }, '/a/b~1c')).toBe(1);
  expect(pointerGet({ '~': [2] }, '/~0/0')).toBe(2);
  expect(pointerGet({}, '/constructor')).toBeUndefined();
  expect(normalizePath('./x', '/r')).toBe('x');
  expect(normalizePath('/r/x', '/r')).toBe('x');
  expect(normalizePath('/other/x', '/r')).toBe('/other/x');
  expect(await collect(adaptorFor('trace')!.parse(linesOf('bad\nnull\n{"op":"read","path":"a"}'), opts))).toEqual([{ session: 's', seq: 0, op: 'read', path: 'a', tool: 'trace', origin: 'trace', ts: undefined }]);
  for (const text of ['{}', 'bad', '{"type":"title"}\nbad', '']) await expect(collect(adaptorFor('pi')!.parse(linesOf(text), opts))).rejects.toThrow('not a session file');
});
test('OMP title slot, metadata and tool results produce only four file events', async () => {
  const text = await Bun.file(ompPath).text(), opts = { session: ompId, branches: 'active' as const, stream: false };
  const events = await collect(adaptorFor('omp')!.parse(linesOf(text), opts));
  expect(events.map(e => [e.tool, e.op, e.path, e.seq])).toEqual([
    ['read', 'read', 'src/a.ts', 0], ['edit', 'write', 'src/a.ts', 1],
    ['edit', 'write', 'src/b.ts', 2], ['write', 'write', 'src/c.ts', 3],
  ]);
  expect(events.every(e => e.origin === 'omp' && e.session === ompId)).toBe(true);
  expect(events[1].ts).toBe(events[2].ts);
  expect(await collect(adaptorFor('omp')!.parse(linesOf(text.split('\n').slice(1).join('\n')), opts))).toEqual(events);
  expect(await collect(adaptorFor('omp')!.parse(linesOf(text), { ...opts, stream: true }))).toEqual(events);
});
test('bounded tree discovery accepts title/header and rejects non-session or lazy files', async () => {
  expect(await treeDescribe(ompPath)).toEqual({ id: ompId, repo: '/home/user/repo' });
  const dir = await mkdtemp(join(tmpdir(), 'am-describe-')), path = join(dir, 'session.jsonl');
  try {
    for (const text of ['{"op":"read","path":"a"}', '', '{"type":"title"}\n', 'bad']) {
      await Bun.write(path, text);
      expect(await treeDescribe(path)).toBeUndefined();
    }
    await Bun.write(path, (await Bun.file(ompPath).text()).split('\n').slice(1).join('\n'));
    expect(await treeDescribe(path)).toEqual({ id: ompId, repo: '/home/user/repo' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('OMP selectors, file URI rejection and hashline headers', async () => {
  expect(stripSelector('a/b.ts:2-4:raw')).toBe('a/b.ts');
  expect(stripSelector('file.db:t:k')).toBe('file.db');
  expect(stripSelector('archive.zip:member/path')).toBe('archive.zip:member/path');
  expect(stripSelector('xd://eval/judge')).toBe('xd://eval/judge');
  for (const raw of ['xd://eval/judge', 'https://x/y', 'local://plan.md', 'artifact://9:1863', 'skill://ponytail', 'proc://', 'a\nb']) expect(fileLike(raw)).toBe(false);
  expect(fileLike('C:\\x')).toBe(true);
  const edit = (await Bun.file(ompPath).text()).split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(e => e?.id === 'a2').message.content[0];
  const rule = { op: 'write' as const, path: '/input', format: 'hashline' as const };
  expect(rulePaths(rule, edit.arguments)).toEqual(['src/a.ts', 'src/b.ts']);
  expect(rulePaths(rule, { input: 1 })).toEqual([]);
});
test('all adaptors reject non-file tool paths', async () => {
  const paths = ['xd://lsp', 'https://x/y', 'local://plan.md', 'a\nb', 'src/a.ts'];
  for (const source of ['pi', 'copilot', 'trace'] as const) {
    const records = source === 'trace' ? paths.map(path => ({ op: 'read', path })) : source === 'copilot'
      ? paths.map(path => ({ type: 'tool.execution_start', data: { toolName: 'view', arguments: { path } } }))
      : [{ type: 'session', id: 'header', cwd: '/repo' }, { type: 'message', id: 'a', parentId: null, timestamp: '2026-10-03T12:00:03Z', message: { role: 'assistant', content: paths.map(path => ({ type: 'toolCall', name: 'read', arguments: { path } })) } }];
    const events = await collect(adaptorFor(source)!.parse(linesOf(records.map(e => JSON.stringify(e)).join('\n')), { session: 's', branches: 'active', stream: false }));
    expect(events.map(e => [e.path, e.seq])).toEqual([['src/a.ts', 0]]);
  }
});
test('registry discovery and opening by identity', async () => {
  const sessions = await discover();
  expect(sessions.map(s => s.id)).toEqual(expect.arrayContaining([
    'pi:' + piId, 'pi:01a0f2df-4b2f-75bd-8355-e950fa6b5bcf',
    'copilot:2f0b1c3e-0000-4000-8000-000000000001', 'omp:' + ompId,
  ]));
  expect(await discover('omp')).toEqual([expect.objectContaining({ id: 'omp:' + ompId, repo: '/home/user/repo', path: ompPath })]);
  const events: FileEvent[] = await collect(await openSession('omp', ompId, { branches: 'active', follow: false }));
  expect(events.map(e => [e.op, e.path])).toEqual([['read','src/a.ts'],['write','src/a.ts'],['write','src/b.ts'],['write','src/c.ts']]);
  await expect(openSession('nope' as Source, ompId, { branches: 'active', follow: false })).rejects.toThrow('unknown source: nope');
});
