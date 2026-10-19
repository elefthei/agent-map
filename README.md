# agent-map

Bun workspace: Pi, Copilot CLI, and raw JSONL file accesses → separate reads/writes transition graphs → SSE/Cytoscape replay and deterministic Mermaid output.

## Run

```sh
bun install
bun test
bun run build:web
bun run server                 # http://localhost:3000, built UI + API
# Or run `bun run web` alongside the server for Vite at http://localhost:5173.

bun packages/cli/src/index.ts run --source pi --session <uuid-or-path> --out out
bun packages/cli/src/index.ts run --source pi --session /tmp/live.jsonl --follow --id live
# Ctrl-C writes both Mermaid views before exiting.
```

CLI flags: repeat `--session` to merge logs; `--branches active|all`; `--scale linear|log`; `--id <filename>` for stable output names. Source is `pi` (default), `copilot`, or `trace`. Trace input is JSONL: `{"op":"read","path":"src/a.ts","ts":1700000000000,"tool":"read"}` (`ts` and `tool` optional). Paths containing newlines are rejected because graph edge IDs use that separator.

The browser groups discovered sessions by source/repository. Select sessions and Start; fixed/scaled modes play automatically, single-step mode waits for Step or Play. Pause, Step, seek, speed changes, and Stop work on the same replay. Stop/completion reveals per-view Mermaid with Copy/Download. Follow accepts one log, keeps receiving complete appended lines, and finishes on Stop.

## Configuration

- `PI_SESSIONS_DIR`: defaults to `~/.pi/agent/sessions`.
- `COPILOT_SESSIONS_DIR`: defaults to `~/.copilot/session-state` (nested `events.jsonl` and legacy flat JSONL).
- `AGENT_MAP_OUT`: server output directory, default `out`.
- `PORT`: server port, default `3000`; Vite's development proxy targets port 3000.

Run the server from this repository root so `packages/web/dist` resolves. It binds to loopback: the API can read local session paths and is not an authenticated multi-user service.

Fixture-backed demo:

```sh
PI_SESSIONS_DIR=fixtures/pi COPILOT_SESSIONS_DIR=fixtures/copilot bun run server
bun packages/cli/src/index.ts run --source pi \
  --session fixtures/pi/--home-user-repo--/2026-10-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl \
  --out /tmp/am --id demo
```

## Semantics and limits

- Accesses count at tool-call time, including failed calls. Only mapped file tools count; shell/directory/search tools do not infer file accesses.
- Pi's active branch is root → last entry. All-branch mode replays each leaf with a separate session ID; shared prefixes count once per branch. Follow uses file order, not branch reconstruction.
- Non-follow logs merge by epoch timestamp, session ID, then sequence. Transitions stay within each session and view; consecutive repeats increase weight without self-loops.
- Each completed/stopped replay writes `<id>.reads.mmd` and `<id>.writes.mmd`. Output depends only on the consumed event prefix, including after seek.
- Default rules: `packages/core/rules/{pi,copilot}.json`, with RFC 6901 pointers and optional tool-name prefix wildcards. Copilot `view`/`edit`/`create` currently assume the argument `path`; that field is **not verified against a real Copilot log**. The Copilot fixture is synthetic, based on the documented envelope. The first Pi fixture is redacted from a real session.
- Scaled mode caps idle delays at `MAX_GAP_MS = 5000` in `replay.ts`. Follow uses `fs.watch`; reducer copies and browser recoloring are O(graph size). No directory collapsing, top-N filtering, or ELK layout.

## API

- `GET /api/sessions?source=pi|copilot&repo=…`
- `POST /api/replays` with `{sessionIds:["pi:<uuid>","trace:<path>"], mode:"fixed"|"scaled"|"step", speed:10, branches:"active"|"all", follow:false}`.
- `GET /api/replays/:id` — snapshot.
- `GET /api/replays/:id/events` — SSE `snapshot`, `diff`, `progress`, `done`, heartbeat `ping`.
- `POST /api/replays/:id/control` with `{action:"play"|"pause"|"step"|"seek"|"stop", speed?, to?}`.
- `GET /api/replays/:id/mermaid?view=reads|writes` — available only after stop/completion.

Core's root export is browser-safe; parsers live at `@agent-map/core/parsers`. Pi packages are development-only type imports. Bun runs core/server/CLI TypeScript directly; Vite builds only the web package.
