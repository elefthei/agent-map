import { applyDiff, initialState, type DiffMessage, type DoneMessage, type GraphState, type ProgressMessage, type SessionInfo, type SourceInfo, type Snapshot, type View } from '@agent-map/core';
import { Graph } from './graph';
import './style.css';
const el = <T extends HTMLElement>(id: string) => document.querySelector<T>('#' + id)!;
const ui = {
  source: el<HTMLSelectElement>('source'), sourceDir: el('source-dir'),
  sessions: el('sessions'), mode: el<HTMLSelectElement>('mode'), speed: el<HTMLInputElement>('speed'), branches: el<HTMLSelectElement>('branches'), follow: el<HTMLInputElement>('follow'),
  start: el<HTMLButtonElement>('start'), play: el<HTMLButtonElement>('play'), pause: el<HTMLButtonElement>('pause'), step: el<HTMLButtonElement>('step'), stop: el<HTMLButtonElement>('stop'),
  seek: el<HTMLInputElement>('seek'), progress: el('progress'), empty: el('empty'), view: el('view-label'), mermaid: el('mermaid'), error: el('error'),
};
const texts = { reads: el<HTMLTextAreaElement>('mermaid-reads'), writes: el<HTMLTextAreaElement>('mermaid-writes') };
const store: { sources: SourceInfo[]; source: string; sessions: SessionInfo[]; selected: Set<string>; snap?: Snapshot; state: GraphState; view: View } = { sources: [], source: '', sessions: [], selected: new Set(), state: initialState(), view: 'reads' };
const graphs = { reads: new Graph(el('cy-reads'), 'reads'), writes: new Graph(el('cy-writes'), 'writes') };
let es: EventSource | undefined, starting = false;
const terminal = () => store.snap?.status === 'stopped' || store.snap?.status === 'completed';
function error(e: unknown) { ui.error.textContent = e instanceof Error ? e.message : String(e); ui.error.hidden = false; }
function clearError() { ui.error.hidden = true; }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const text = await res.text(); throw Error(`${res.status}: ${text}`); }
  return res.json();
}
function render() {
  const s = store.snap, finished = terminal();
  ui.start.disabled = starting || !store.selected.size || (ui.follow.checked && store.selected.size !== 1);
  ui.start.textContent = store.selected.size ? `Start replay · ${store.selected.size} selected` : 'Start replay';
  ui.play.disabled = !s || s.status === 'playing' || finished;
  ui.pause.disabled = !s || s.status !== 'playing';
  ui.step.disabled = !s || !['created','paused'].includes(s.status);
  ui.stop.disabled = !s || finished; ui.seek.disabled = !s || finished;
  if (s) { ui.progress.textContent = `${s.cursor}/${s.total}${s.ended ? '' : '+'} · ${s.status}`; ui.seek.max = String(s.total); ui.seek.value = String(s.cursor); }
  graphs.reads.show(store.view === 'reads'); graphs.writes.show(store.view === 'writes');
  ui.view.textContent = store.view.toUpperCase();
  ui.empty.hidden = Object.keys(store.state[store.view].nodes).length > 0;
}
function snapshot(s: Snapshot) {
  store.snap = s; store.state = s.state;
  graphs.reads.reset(s.state.reads); graphs.writes.reset(s.state.writes); render();
}
function output(m: DoneMessage['mermaid']) { texts.reads.value = m.reads; texts.writes.value = m.writes; ui.mermaid.hidden = false; }
function renderSources() {
  ui.source.replaceChildren(...store.sources.map(s => new Option(`${s.label} (${store.sessions.filter(session => session.source === s.source).length})`, s.source, false, s.source === store.source)));
  ui.sourceDir.textContent = store.sources.find(s => s.source === store.source)?.dir ?? '';
}
function renderSessions() {
  ui.sessions.replaceChildren();
  const groups = new Map<string, SessionInfo[]>();
  for (const s of store.sessions.filter(s => s.source === store.source)) { const key = s.repo || '(unknown repository)'; groups.set(key, [...(groups.get(key) ?? []), s]); }
  for (const [key, sessions] of groups) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.open = groups.size <= 5; summary.textContent = key; details.append(summary);
    for (const s of sessions) {
      const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
      input.type = 'checkbox'; input.value = s.id; input.checked = store.selected.has(s.id);
      input.addEventListener('change', () => { input.checked ? store.selected.add(s.id) : store.selected.delete(s.id); render(); });
      text.textContent = `${s.path.split('/').pop()} · ${new Date(s.modified).toLocaleDateString()}`;
      label.append(input, text); details.append(label);
    }
    ui.sessions.append(details);
  }
  if (!groups.size) {
    const source = store.sources.find(s => s.source === store.source);
    ui.sessions.textContent = `No ${source?.label ?? 'log'} sessions found under ${source?.dir ?? ''}.`;
  }
}
async function control(action: string, extra: Record<string, unknown> = {}) {
  if (!store.snap) return;
  clearError();
  // SSE owns state: a delayed control response must never rewind newer progress.
  await request<Snapshot>(`/api/replays/${store.snap.id}/control`, { action, ...extra });
}
async function start() {
  starting = true; clearError(); render();
  try {
    if (store.snap && !terminal()) await control('stop');
    es?.close();
    const speed = Number(ui.speed.value);
    if (!Number.isFinite(speed) || speed <= 0) throw Error('Speed must be a positive number.');
    const s = await request<Snapshot>('/api/replays', { sessionIds: [...store.selected], mode: ui.mode.value, speed, branches: ui.branches.value, follow: ui.follow.checked });
    ui.mermaid.hidden = true; texts.reads.value = ''; texts.writes.value = ''; snapshot(s);
    const stream = es = new EventSource(`/api/replays/${s.id}/events`);
    let autoplay = s.mode !== 'step', doneReceived = false;
    stream.addEventListener('snapshot', e => {
      const next: Snapshot = JSON.parse((e as MessageEvent).data); snapshot(next);
      if (next.mermaid) output(next.mermaid);
      if (autoplay && next.status === 'created') { autoplay = false; void control('play').catch(error); }
    });
    stream.addEventListener('diff', e => {
      const { ops }: DiffMessage = JSON.parse((e as MessageEvent).data);
      store.state = applyDiff(store.state, ops);
      for (const v of ['reads','writes'] as View[]) graphs[v].apply(ops.filter(op => op.view === v), store.state[v]);
      render();
    });
    stream.addEventListener('progress', e => {
      const p: ProgressMessage = JSON.parse((e as MessageEvent).data);
      if (store.snap) store.snap = { ...store.snap, ...p };
      render();
      if (doneReceived && terminal()) stream.close();
    });
    stream.addEventListener('done', e => {
      const done: DoneMessage = JSON.parse((e as MessageEvent).data);
      output(done.mermaid); doneReceived = true;
      // Finish emits done before its final progress; keep the stream until both arrive.
      if (terminal()) stream.close();
    });
    stream.onerror = () => { if (!terminal()) error('Event stream disconnected; reconnecting with a fresh snapshot…'); };
    stream.onopen = clearError;
  } catch (e) { error(e); }
  finally { starting = false; render(); }
}
ui.source.addEventListener('change', () => { store.source = ui.source.value; renderSources(); renderSessions(); render(); });
ui.start.addEventListener('click', () => { void start(); });
for (const action of ['play','pause','step','stop'] as const) ui[action].addEventListener('click', () => { void control(action).catch(error); });
ui.seek.addEventListener('change', () => { void control('seek', { to: Number(ui.seek.value) }).catch(error); });
ui.speed.addEventListener('change', () => {
  if (!store.snap || terminal()) return;
  const speed = Number(ui.speed.value);
  if (!Number.isFinite(speed) || speed <= 0) { error('Speed must be a positive number.'); return; }
  void control(store.snap.status === 'playing' ? 'play' : 'pause', { speed }).catch(error);
});
ui.follow.addEventListener('change', render);
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=view]')) radio.addEventListener('change', () => { store.view = radio.value as View; render(); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) button.addEventListener('click', () => { void navigator.clipboard.writeText(texts[button.dataset.copy as View].value).catch(error); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-download]')) button.addEventListener('click', () => {
  const view = button.dataset.download as View, url = URL.createObjectURL(new Blob([texts[view].value], { type: 'text/plain' })), a = document.createElement('a');
  a.href = url; a.download = `${store.snap!.id}.${view}.mmd`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
render();
Promise.all([request<SourceInfo[]>('/api/sources'), request<SessionInfo[]>('/api/sessions')]).then(([sources, sessions]) => {
  store.sources = sources; store.sessions = sessions;
  store.source = sources.find(s => sessions.some(session => session.source === s.source))?.source ?? sources[0]?.source ?? '';
  renderSources(); renderSessions(); render();
}).catch(error);
