import { edgeId, type DiffOp, type FileEvent, type GraphState, type Op, type View, type ViewState } from './types';
export const emptyView = (): ViewState => ({ nodes: {}, edges: {}, last: {}, maxNode: 0, maxEdge: 0 });
export const initialState = (): GraphState => ({ reads: emptyView(), writes: emptyView() });
export const viewOf = (op: Op): View => op === 'read' ? 'reads' : 'writes';
export function applyDiff(state: GraphState, ops: DiffOp[]): GraphState {
  const next = { ...state };
  const copied = new Set<View>();
  // ponytail: O(nodes) copy per event; fine to ~10^4 nodes, switch to persistent maps if it ever shows up.
  for (const op of ops) {
    if (!copied.has(op.view)) {
      const v = next[op.view];
      next[op.view] = { ...v, nodes: { ...v.nodes }, edges: { ...v.edges } };
      copied.add(op.view);
    }
    const v = next[op.view];
    if (op.t === 'addNode') Object.defineProperty(v.nodes, op.id, { value: 0, writable: true, enumerable: true, configurable: true });
    else if (op.t === 'addEdge') v.edges[edgeId(op.from, op.to)] = 0;
    else if (op.kind === 'node') { v.nodes[op.id] = op.weight; v.maxNode = Math.max(v.maxNode, op.weight); }
    else { v.edges[op.id] = op.weight; v.maxEdge = Math.max(v.maxEdge, op.weight); }
  }
  return next;
}
export function reduce(state: GraphState, ev: FileEvent): { state: GraphState; diff: DiffOp[] } {
  const view = viewOf(ev.op), v = state[view], diff: DiffOp[] = [];
  if (!Object.hasOwn(v.nodes, ev.path)) diff.push({ t: 'addNode', view, id: ev.path });
  diff.push({ t: 'bumpWeight', view, kind: 'node', id: ev.path, weight: (Object.hasOwn(v.nodes, ev.path) ? v.nodes[ev.path] : 0) + 1 });
  const prev = Object.hasOwn(v.last, ev.session) ? v.last[ev.session] : undefined;
  if (prev !== undefined && prev !== ev.path) {
    const id = edgeId(prev, ev.path);
    if (!Object.hasOwn(v.edges, id)) diff.push({ t: 'addEdge', view, from: prev, to: ev.path });
    diff.push({ t: 'bumpWeight', view, kind: 'edge', id, weight: (v.edges[id] ?? 0) + 1 });
  }
  const next = applyDiff(state, diff);
  next[view] = { ...next[view], last: { ...next[view].last, [ev.session]: ev.path } };
  return { state: next, diff };
}
