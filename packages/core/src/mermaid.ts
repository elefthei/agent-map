import { heatOf, RAMP, type Scale } from './heat';
import type { GraphState, View } from './types';
export function toMermaid(state: GraphState, view: View, scale: Scale = 'linear'): string {
  const v = state[view], paths = Object.keys(v.nodes).sort(), edges = Object.keys(v.edges).sort();
  const ids = new Map(paths.map((p, i) => [p, `n${i}`]));
  const out = ['flowchart LR'];
  for (const p of paths) out.push(`  ${ids.get(p)}["${p.replaceAll('"', '#quot;')}"]:::h${heatOf(v.nodes[p], v.maxNode, scale)}`);
  for (const e of edges) { const [from, to] = e.split('\n'); out.push(`  ${ids.get(from)} --> ${ids.get(to)}`); }
  RAMP.forEach((c, i) => out.push(`  classDef h${i} fill:${c},stroke:${c},color:#000`));
  edges.forEach((e, i) => out.push(`  linkStyle ${i} stroke:${RAMP[heatOf(v.edges[e], v.maxEdge, scale)]},stroke-width:2px`));
  return out.join('\n') + '\n';
}
