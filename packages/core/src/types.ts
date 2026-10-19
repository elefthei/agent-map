export type Op = 'read' | 'write';
export type View = 'reads' | 'writes';
export type Origin = 'copilot' | 'pi' | 'omp' | 'trace';
export interface FileEvent { session: string; seq: number; ts?: number; op: Op; path: string; tool: string; origin: Origin }
export interface ViewState { nodes: Record<string, number>; edges: Record<string, number>; last: Record<string, string>; maxNode: number; maxEdge: number }
export interface GraphState { reads: ViewState; writes: ViewState }
export type DiffOp =
  | { t: 'addNode'; view: View; id: string }
  | { t: 'addEdge'; view: View; from: string; to: string }
  | { t: 'bumpWeight'; view: View; kind: 'node' | 'edge'; id: string; weight: number };
// Parsers reject newlines in paths: the wire edge ID uses one as its separator.
export const edgeId = (from: string, to: string) => `${from}\n${to}`;
export type Source = Origin;
export interface SessionInfo { id: string; source: Source; repo: string; path: string; modified: number }
export interface SourceInfo { source: Source; label: string; dir: string }
export type Status = 'created' | 'playing' | 'paused' | 'stopped' | 'completed';
export type Mode = 'fixed' | 'scaled' | 'step';
export interface Snapshot { id: string; status: Status; cursor: number; total: number; ended: boolean; mode: Mode; speed: number; state: GraphState; mermaid?: Record<View, string> }
export interface DiffMessage { seq: number; ops: DiffOp[] }
export interface ProgressMessage { cursor: number; total: number; status: Status; ended: boolean }
export interface DoneMessage { mermaid: Record<View, string>; files: string[] }
