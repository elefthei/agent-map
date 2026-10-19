import { describe, expect, test } from 'bun:test';
import { applyDiff, edgeId, heatOf, initialState, reduce, toMermaid, type FileEvent, type GraphState, type View } from '../src';
import { linesOf, matchRule, normalizePath, parseCopilot, parsePi, parseTrace, pointerGet } from '../src/parsers';
const fixture = async (p: string) => linesOf(await Bun.file(new URL('../../../fixtures/' + p, import.meta.url)).text());
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const e of it) out.push(e); return out; }
const reduceAll = (events: FileEvent[]) => events.reduce((s, e) => reduce(s, e).state, initialState());
const branches = 'pi/--home-user-repo--/2026-10-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl';
const copilot = 'copilot/2f0b1c3e-0000-4000-8000-000000000001/events.jsonl';
const piActive = () => fixture(branches).then(l => collect(parsePi(l)));
const piAll = () => fixture(branches).then(l => collect(parsePi(l, { branches: 'all' })));
const cp = () => fixture(copilot).then(l => collect(parseCopilot(l, 'copilot-fixture')));
const event = (path: string, seq = 0, session = 's'): FileEvent => ({ path, seq, session, op: 'read', tool: 'read', origin: 'trace' });
const visible = (s: GraphState) => Object.fromEntries((['reads', 'writes'] as View[]).map(v => { const { last, ...rest } = s[v]; return [v, rest]; }));
describe('graph reduction', () => {
  test('weights, exact diffs, session isolation, no self-loops, purity', () => {
    const empty = initialState(), r1 = reduce(empty, event('A'));
    expect(r1.diff).toEqual([{ t: 'addNode', view: 'reads', id: 'A' }, { t: 'bumpWeight', view: 'reads', kind: 'node', id: 'A', weight: 1 }]);
    const r2 = reduce(r1.state, event('B', 1));
    expect(r2.diff).toEqual([{ t: 'addNode', view: 'reads', id: 'B' }, { t: 'bumpWeight', view: 'reads', kind: 'node', id: 'B', weight: 1 }, { t: 'addEdge', view: 'reads', from: 'A', to: 'B' }, { t: 'bumpWeight', view: 'reads', kind: 'edge', id: 'A\nB', weight: 1 }]);
    const s = reduceAll([event('A'), event('B', 1), event('A', 2)]);
    expect(s.reads.nodes).toEqual({ A: 2, B: 1 });
    expect(s.reads.edges).toEqual({ [edgeId('A', 'B')]: 1, [edgeId('B', 'A')]: 1 });
    expect(s.writes).toEqual(empty.writes);
    expect(empty).toEqual(initialState());
    expect(r1.state.reads.nodes).toEqual({ A: 1 });
    expect(reduceAll([event('A', 0, 's1'), event('C', 0, 's2'), event('B', 1, 's1')]).reads.edges).toEqual({ 'A\nB': 1 });
    expect(reduceAll([event('A'), event('A', 1)]).reads.edges).toEqual({});
  });
  test('diff reconstruction invariant for every branch event', async () => {
    let state = initialState();
    for (const e of await piAll()) {
      const prev = structuredClone(state), r = reduce(state, e);
      expect(visible(applyDiff(state, r.diff))).toEqual(visible(r.state));
      expect(state).toEqual(prev);
      state = r.state;
    }
  });
  test('record keys are file paths, not inherited object properties', () => {
    const s = reduceAll([event('__proto__'), event('constructor')]);
    expect(s.reads.nodes['__proto__']).toBe(1);
    expect(s.reads.nodes.constructor as unknown).toBe(1);
    expect(s.reads.edges['__proto__\nconstructor']).toBe(1);
  });
});
test('heat boundaries and log scaling', () => {
  for (const [w, m, expected] of [[1,1,0],[1,10,0],[10,10,8],[5,9,4],[0,5,0]]) expect(heatOf(w, m)).toBe(expected);
  expect(heatOf(10, 100, 'log')).toBe(4);
  expect(heatOf(0, 5, 'log')).toBe(0);
});
test('deterministic Mermaid snapshots and independent session merge order', async () => {
  const p = await piActive(), c = await cp(), s = reduceAll(p);
  expect(toMermaid(s, 'reads')).toMatchSnapshot();
  expect(toMermaid(s, 'writes')).toMatchSnapshot();
  expect(toMermaid(s, 'reads')).toContain('n0["src/a.ts"]');
  expect(toMermaid(s, 'reads').match(/linkStyle/g)).toHaveLength(2);
  for (const v of ['reads', 'writes'] as View[]) expect(toMermaid(reduceAll([...p, ...c]), v)).toBe(toMermaid(reduceAll([...c, ...p]), v));
});
test('Pi real session and active/all branches', async () => {
  const real = await collect(parsePi(await fixture('pi/--home-user-repo--/2026-09-30T15-11-55-183Z_01a0f2df-4b2f-75bd-8355-e950fa6b5bcf.jsonl')));
  expect(real.map(({ op, path, tool, seq }) => ({ op, path, tool, seq }))).toEqual([0,1].map(seq => ({ op: 'read', path: 'test.txt', tool: 'read', seq })));
  const active = await piActive();
  expect(active.map(e => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  expect(active.every(e => e.op === 'read')).toBe(true);
  expect(new Set(active.map(e => e.session)).size).toBe(1);
  const all = await piAll(), id = '11111111-1111-4111-8111-111111111111';
  expect(all.filter(e => e.session === id + '#e5').map(e => [e.op, e.path, e.seq])).toEqual([['read','src/a.ts',0],['read','src/b.ts',1],['write','src/b.ts',2],['read','src/a.ts',3],['write','src/a.ts',4]]);
  expect(all.filter(e => e.session === id + '#e6').map(e => e.path)).toEqual(active.map(e => e.path));
});
test('Copilot and raw trace parsers', async () => {
  expect((await cp()).map(e => [e.tool, e.path, e.op])).toEqual([['view','src/a.ts','read'],['edit','src/b.ts','write'],['view','src/b.ts','read']]);
  const trace = await collect(parseTrace(await fixture('trace/sample.jsonl'), 'trace'));
  expect(trace.map(e => [e.op, e.path])).toEqual([['read','src/a.ts'],['write','src/a.ts']]);
  expect(trace[1].ts).toBe(1700000000000);
});
test('rules, pointers, normalization and malformed input', async () => {
  const r = { op: 'read' as const, path: '/path' };
  expect(matchRule({ 'mcp__fs__*': r }, 'mcp__fs__read')).toBe(r);
  expect(pointerGet({ a: { 'b/c': 1 } }, '/a/b~1c')).toBe(1);
  expect(pointerGet({ '~': [2] }, '/~0/0')).toBe(2);
  expect(pointerGet({}, '/constructor')).toBeUndefined();
  expect(normalizePath('./x', '/r')).toBe('x');
  expect(normalizePath('/r/x', '/r')).toBe('x');
  expect(normalizePath('/other/x', '/r')).toBe('/other/x');
  expect(await collect(parseTrace(linesOf('bad\nnull\n{"op":"read","path":"a"}'), 's'))).toEqual([{ ...event('a'), tool: 'trace', ts: undefined }]);
  await expect(collect(parsePi(linesOf('{}')))).rejects.toThrow('not a pi session file');
});
