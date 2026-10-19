import { EventEmitter, once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { initialState, reduce, toMermaid, type DoneMessage, type FileEvent, type Mode, type ProgressMessage, type Scale, type Snapshot, type Status, type View } from '@agent-map/core';
export interface ReplayOptions { mode: Mode; speed: number; outDir: string; scale?: Scale }
export const MAX_GAP_MS = 5000;
export class Replay extends EventEmitter {
  status: Status = 'created'; cursor = 0; readonly events: FileEvent[] = []; ended = false; state = initialState(); mermaid?: Record<View, string>;
  private running = false;
  private wake?: AbortController;
  private finishing?: Promise<void>;
  constructor(public readonly id: string, source: AsyncIterable<FileEvent>, private opts: ReplayOptions, public readonly abort = new AbortController()) {
    super();
    void (async () => {
      try {
        for await (const ev of source) { if (this.finished) break; this.events.push(ev); this.emit('append'); this.progress(); }
      } catch (e) { if (!abort.signal.aborted) console.error(e); }
      finally { this.ended = true; this.emit('append'); this.progress(); }
    })();
  }
  private get finished() { return this.status === 'stopped' || this.status === 'completed'; }
  private progress() {
    const { cursor, status, ended } = this;
    this.emit('progress', { cursor, total: this.events.length, status, ended } satisfies ProgressMessage);
  }
  play(): void {
    if (this.finished) return;
    this.status = 'playing'; this.progress();
    if (!this.running) void this.run().catch(e => { console.error(e); this.emit('failure', e); });
  }
  pause(): void { if (this.status === 'playing') { this.status = 'paused'; this.wake?.abort(); this.progress(); } }
  step(): void {
    if (this.status !== 'created' && this.status !== 'paused') return;
    if (this.cursor < this.events.length) this.tick();
    this.progress();
  }
  seek(to: number): void {
    if (this.finished) return;
    to = Math.max(0, Math.min(Math.trunc(to), this.events.length));
    this.state = this.events.slice(0, to).reduce((s, e) => reduce(s, e).state, initialState());
    this.cursor = to; this.wake?.abort(); this.emit('snapshot', this.snapshot());
  }
  setSpeed(n: number): void { this.opts.speed = n; }
  async stop(): Promise<void> { if (this.finishing) return this.finishing; if (!this.finished) await this.finish('stopped'); }
  snapshot(): Snapshot {
    return { id: this.id, status: this.status, cursor: this.cursor, total: this.events.length, ended: this.ended, mode: this.opts.mode, speed: this.opts.speed, state: this.state, mermaid: this.mermaid };
  }
  private delay(): number {
    const { mode, speed } = this.opts;
    if (speed === Infinity || mode === 'step') return 0;
    if (mode === 'fixed') return 1000 / speed;
    const prev = this.events[this.cursor - 1], ev = this.events[this.cursor];
    return prev?.ts !== undefined && ev.ts !== undefined ? Math.max(0, Math.min((ev.ts - prev.ts) / speed, MAX_GAP_MS)) : 0;
  }
  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.status === 'playing') {
        this.wake = new AbortController();
        const signal = this.wake.signal;
        try {
          if (this.cursor >= this.events.length) {
            if (this.ended) { await this.finish('completed'); return; }
            await once(this, 'append', { signal }); continue;
          }
          const wait = this.delay();
          // ponytail: speed=Infinity never yields to the event loop; sessions are small.
          if (wait > 0) await sleep(wait, undefined, { signal });
        } catch (e) { if ((e as Error).name === 'AbortError') continue; throw e; }
        if (this.status !== 'playing') return;
        this.tick();
        if (this.opts.mode === 'step') { this.status = 'paused'; this.progress(); return; }
      }
    } finally { this.running = false; this.wake = undefined; }
  }
  private tick(): void {
    const ev = this.events[this.cursor++], result = reduce(this.state, ev);
    this.state = result.state; this.emit('diff', { seq: this.cursor, ops: result.diff }); this.progress();
  }
  private finish(status: 'stopped' | 'completed'): Promise<void> {
    if (this.finishing) return this.finishing;
    this.status = status; this.wake?.abort(); this.abort.abort();
    this.finishing = (async () => {
      this.mermaid = { reads: toMermaid(this.state, 'reads', this.opts.scale), writes: toMermaid(this.state, 'writes', this.opts.scale) };
      await mkdir(this.opts.outDir, { recursive: true });
      const files = (['reads', 'writes'] as const).map(v => join(this.opts.outDir, `${this.id}.${v}.mmd`));
      await Promise.all(files.map((f, i) => Bun.write(f, this.mermaid![i === 0 ? 'reads' : 'writes'])));
      this.emit('done', { mermaid: this.mermaid, files } satisfies DoneMessage); this.progress();
    })();
    return this.finishing;
  }
}
