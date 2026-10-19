import cytoscape, { type Core } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { edgeId, heatOf, RAMP, type DiffOp, type View, type ViewState } from '@agent-map/core';
cytoscape.use(dagre);
export class Graph {
  private cy: Core;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private container: HTMLElement, private view: View) {
    this.cy = cytoscape({ container, elements: [], maxZoom: 3, style: [
      { selector: 'node', style: { label: 'data(id)', 'font-size': 11, 'text-valign': 'bottom', 'text-margin-y': 9, color: '#33443c', width: 30, height: 30, 'border-width': 2, 'border-color': '#ffffff' } },
      { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', width: 2 } },
      ...RAMP.flatMap((c, i) => [
        { selector: `node[heat = ${i}]`, style: { 'background-color': c } },
        { selector: `edge[heat = ${i}]`, style: { 'line-color': c, 'target-arrow-color': c } },
      ]),
    ] });
    this.cy.pan({ x: container.clientWidth / 3, y: container.clientHeight / 3 });
    new ResizeObserver(() => { this.cy.resize(); this.layout(); }).observe(container);
  }
  apply(ops: DiffOp[], v: ViewState): void {
    if (!ops.length) return;
    const changed = ops.some(op => op.view === this.view && (op.t === 'addNode' || op.t === 'addEdge'));
    this.cy.batch(() => {
      for (const op of ops) {
        if (op.view !== this.view) continue;
        if (op.t === 'addNode') this.cy.add({ group: 'nodes', data: { id: op.id, weight: 0, heat: 0 } });
        else if (op.t === 'addEdge') {
          this.cy.add({ group: 'edges', data: { id: edgeId(op.from, op.to), source: op.from, target: op.to, weight: 0, heat: 0 } });
          const to = this.cy.$id(op.to), src = this.cy.$id(op.from);
          if (to.data('placed') !== true) {
            const horizontal = this.cy.width() >= this.cy.height();
            to.position({ x: src.position('x') + (horizontal ? 40 : 0), y: src.position('y') + (horizontal ? 0 : 40) });
            to.data('placed', true);
          }
        } else this.cy.$id(op.id).data('weight', op.weight);
      }
      // ponytail: O(n) recolor per batch; only recolor touched elements if max is unchanged, when n gets large.
      this.cy.nodes().forEach(n => { n.data('heat', heatOf(n.data('weight'), v.maxNode)); });
      this.cy.edges().forEach(e => { e.data('heat', heatOf(e.data('weight'), v.maxEdge)); });
    });
    if (changed) {
      this.cy.fit(undefined, 40);
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.layout(); }, 300);
    }
  }
  reset(v: ViewState): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.cy.elements().remove();
    this.cy.add(Object.entries(v.nodes).map(([id, weight]) => ({ group: 'nodes' as const, data: { id, weight, heat: heatOf(weight, v.maxNode) } })));
    this.cy.add(Object.entries(v.edges).map(([id, weight]) => { const [source, target] = id.split('\n'); return { group: 'edges' as const, data: { id, source, target, weight, heat: heatOf(weight, v.maxEdge) } }; }));
    this.layout();
  }
  private layout(): void {
    if (this.cy.nodes().length) {
      // ponytail: use the longer canvas axis; keep the existing Dagre layout rather than adding a packing engine.
      this.cy.layout({ name: 'dagre', rankDir: this.cy.width() >= this.cy.height() ? 'LR' : 'TB', fit: true, padding: 40, nodeDimensionsIncludeLabels: true, animate: false } as cytoscape.LayoutOptions).run();
    } else { this.cy.zoom(1); this.cy.pan({ x: this.container.clientWidth / 3, y: this.container.clientHeight / 3 }); }
  }
  show(on: boolean): void { this.container.style.visibility = on ? 'visible' : 'hidden'; }
}
