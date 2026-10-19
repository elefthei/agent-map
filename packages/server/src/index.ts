import { createApp } from './app';
import type { Replay } from './replay';
const replays = new Map<string, Replay>();
const app = createApp(replays, process.env.AGENT_MAP_OUT ?? 'out');
const port = Number(process.env.PORT ?? 3000);
console.log(`agent-map listening on http://localhost:${port}`);
export default { hostname: '127.0.0.1', port, fetch: app.fetch, idleTimeout: 255 };
