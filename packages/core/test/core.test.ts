import { describe, expect, test } from 'bun:test';
import { applyDiff, edgeId, heatOf, initialState, reduce, toMermaid, type FileEvent, type GraphState, type View } from '../src';
const reduceAll = (events: FileEvent[]) => events.reduce((s, e) => reduce(s, e).state, initialState());
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
  test('diff reconstruction invariant for every event', () => {
    let state = initialState();
    for (const e of [event('src/a.ts'), event('src/b.ts', 1), { ...event('src/b.ts', 2), op: 'write' as const }, event('src/a.ts', 3), event('src/c.ts', 0, 'other')]) {
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
test('deterministic Mermaid snapshots and independent session merge order', () => {
  const p = [event('src/a.ts', 0, 'p'), event('src/b.ts', 1, 'p'), event('src/c.ts', 2, 'p')];
  const c: FileEvent[] = [{ ...event('src/a.ts', 0, 'c'), tool: 'view' }, { ...event('src/b.ts', 1, 'c'), op: 'write', tool: 'edit' }, { ...event('src/b.ts', 2, 'c'), tool: 'view' }];
  const s = reduceAll(p);
  expect(toMermaid(s, 'reads')).toMatchSnapshot();
  expect(toMermaid(s, 'writes')).toMatchSnapshot();
  expect(toMermaid(s, 'reads')).toContain('n0["src/a.ts"]');
  expect(toMermaid(s, 'reads').match(/linkStyle/g)).toHaveLength(2);
  for (const v of ['reads', 'writes'] as View[]) expect(toMermaid(reduceAll([...p, ...c]), v)).toBe(toMermaid(reduceAll([...c, ...p]), v));
});
