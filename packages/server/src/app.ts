import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from 'hono/bun';
import { join } from 'node:path';
import type { Source, View } from '@agent-map/core';
import { Replay } from './replay';
import { adaptorFor, adaptors, discover, fromArray, mergeSessions, openSession } from '@agent-map/log-adaptors';
const createSchema = z.object({
  sessionIds: z.array(z.string().regex(new RegExp(`^(${adaptors.map(a => a.source).join('|')}):.+`))).min(1),
  mode: z.enum(['fixed', 'scaled', 'step']).default('fixed'),
  speed: z.number().positive().default(10),
  branches: z.enum(['active', 'all']).default('active'),
  follow: z.boolean().default(false),
});
const controlSchema = z.object({ action: z.enum(['play', 'pause', 'step', 'seek', 'stop']), speed: z.number().positive().optional(), to: z.number().int().min(0).optional() });
const finished = (r: Replay) => r.status === 'stopped' || r.status === 'completed';
export function createApp(replays: Map<string, Replay>, outDir: string): Hono {
  const app = new Hono();
  app.get('/api/sources', c => c.json(adaptors.filter(a => a.dir).map(({ source, label, dir }) => ({ source, label, dir }))));
  app.get('/api/sessions', async c => {
    const source = c.req.query('source');
    if (source !== undefined && !adaptors.some(a => a.source === source && a.dir)) return c.json({ error: 'invalid source' }, 400);
    return c.json(await discover(source === undefined ? undefined : adaptorFor(source)!.source, c.req.query('repo')));
  });
  app.post('/api/replays', zValidator('json', createSchema), async c => {
    const { sessionIds, mode, speed, branches, follow } = c.req.valid('json');
    if (follow && sessionIds.length > 1) return c.json({ error: 'follow accepts one session' }, 400);
    const id = crypto.randomUUID(), abort = new AbortController();
    try {
      const opens = sessionIds.map(s => { const i = s.indexOf(':'); return openSession(s.slice(0, i) as Source, s.slice(i + 1), { branches, follow, signal: abort.signal }); });
      const sources = await Promise.all(opens);
      const source = follow ? sources[0] : fromArray(await mergeSessions(sources));
      const replay = new Replay(id, source, { mode, speed, outDir }, abort);
      replays.set(id, replay);
      return c.json(replay.snapshot(), 201);
    } catch (e) {
      abort.abort();
      const error = e instanceof Error ? e.message : String(e);
      if (error.startsWith('session not found:')) return c.json({ error }, 404);
      if (error === 'not a session file') return c.json({ error }, 400);
      throw e;
    }
  });
  app.get('/api/replays/:id', c => {
    const replay = replays.get(c.req.param('id'));
    return replay ? c.json(replay.snapshot()) : c.json({ error: 'replay not found' }, 404);
  });
  app.get('/api/replays/:id/events', async c => {
    const replay = replays.get(c.req.param('id'));
    if (!replay) return c.json({ error: 'replay not found' }, 404);
    if (finished(replay)) await replay.stop();
    return streamSSE(c, async stream => {
      const send = (event: string, payload: unknown) => stream.writeSSE({ event, data: JSON.stringify(payload) });
      if (finished(replay)) {
        await send('snapshot', replay.snapshot());
        await send('done', { mermaid: replay.mermaid, files: (['reads', 'writes'] as View[]).map(v => join(outDir, `${replay.id}.${v}.mmd`)) });
        return;
      }
      let close!: () => void;
      const closed = new Promise<void>(resolve => { close = resolve; });
      stream.onAbort(close);
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const listeners = new Map<string, (payload: unknown) => void>();
      // Queue the initial frame before registering live updates; no await gap can lose an event.
      let pending = send('snapshot', replay.snapshot());
      for (const event of ['diff', 'progress', 'snapshot', 'done']) {
        const listener = (payload: unknown) => {
          pending = pending.then(() => send(event, payload)).catch(close);
          if (event === 'done') closeTimer = setTimeout(close, 100);
        };
        listeners.set(event, listener); replay.on(event, listener);
      }
      const heartbeat = setInterval(() => { pending = pending.then(() => stream.writeSSE({ event: 'ping', data: '' })).catch(close); }, 15000);
      try { await closed; await pending; }
      finally {
        clearInterval(heartbeat); clearTimeout(closeTimer);
        for (const [event, listener] of listeners) replay.off(event, listener);
      }
    });
  });
  app.post('/api/replays/:id/control', zValidator('json', controlSchema), async c => {
    const replay = replays.get(c.req.param('id'));
    if (!replay) return c.json({ error: 'replay not found' }, 404);
    if (finished(replay)) return c.json({ error: 'replay finished' }, 409);
    const { action, speed, to } = c.req.valid('json');
    if (action === 'seek' && to === undefined) return c.json({ error: 'seek requires to' }, 400);
    if (speed !== undefined) replay.setSpeed(speed);
    if (action === 'seek') replay.seek(to!);
    else if (action === 'stop') await replay.stop();
    else replay[action]();
    return c.json(replay.snapshot());
  });
  app.get('/api/replays/:id/mermaid', async c => {
    const view = c.req.query('view');
    if (view !== 'reads' && view !== 'writes') return c.json({ error: 'invalid view' }, 400);
    const replay = replays.get(c.req.param('id'));
    if (!replay) return c.json({ error: 'replay not found' }, 404);
    if (!finished(replay)) return c.json({ error: 'not finished' }, 409);
    await replay.stop();
    return c.text(replay.mermaid![view]);
  });
  app.use('/*', serveStatic({ root: 'packages/web/dist' }));
  return app;
}
