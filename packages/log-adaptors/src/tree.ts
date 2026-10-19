import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { FileEvent, Origin } from '@agent-map/core';
import { fileLike, matchRule, normalizePath, rulePaths, type Rules } from './rules';
import type { ParseOptions, SessionIdentity } from './types';
export interface TreeFormat { rules: Rules; origin: Origin; path?: (raw: string) => string }
type Line = { type: string; id?: string; parentId?: string | null; timestamp?: string; cwd?: string } & Record<string, unknown>;
function entryEvents(line: Line, session: string, cwd: string, seq: { n: number }, fmt: TreeFormat): FileEvent[] {
  const entry = line as unknown as SessionMessageEntry;
  if (entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) return [];
  const out: FileEvent[] = [];
  for (const item of entry.message.content) {
    if (item.type !== 'toolCall') continue;
    const c: ToolCall = item, rule = matchRule(fmt.rules, c.name);
    if (!rule) continue;
    for (let raw of rulePaths(rule, c.arguments)) {
      if (fmt.path) raw = fmt.path(raw);
      if (!fileLike(raw)) continue;
      // ponytail: no isError filtering; join on toolResult if phantom files matter.
      out.push({ session, seq: seq.n++, ts: Date.parse(entry.timestamp), op: rule.op, path: normalizePath(raw, cwd), tool: c.name, origin: fmt.origin });
    }
  }
  return out;
}
export async function* parseTree(lines: AsyncIterable<string>, fmt: TreeFormat, opts: ParseOptions): AsyncIterable<FileEvent> {
  let header: Line & { id: string; cwd: string } | undefined;
  const entries: (Line & { id: string })[] = [], seq = { n: 0 };
  for await (const line of lines) {
    let parsed: Line;
    try { parsed = JSON.parse(line); } catch {
      if (!header) throw Error('not a session file');
      continue;
    }
    if (!header) {
      if (parsed?.type === 'title') continue;
      if (parsed?.type !== 'session' || typeof parsed.id !== 'string' || typeof parsed.cwd !== 'string') throw Error('not a session file');
      header = parsed as Line & { id: string; cwd: string };
      continue;
    }
    if (!parsed || typeof parsed.id !== 'string' || parsed.type === 'session') continue;
    if (opts.stream) {
      if (parsed.type === 'message') yield* entryEvents(parsed, opts.session, header.cwd, seq, fmt);
    } else entries.push(parsed as Line & { id: string });
  }
  if (!header) throw Error('not a session file');
  if (opts.stream || !entries.length) return;
  const byId = new Map(entries.map(e => [e.id, e]));
  const parents = new Set(entries.map(e => e.parentId));
  const leaves = opts.branches === 'all' ? entries.filter(e => !parents.has(e.id)) : entries.slice(-1);
  for (const leaf of leaves) {
    const chain: typeof entries = [], seen = new Set<string>();
    let entry: typeof leaf | undefined = leaf;
    while (entry && !seen.has(entry.id)) { chain.push(entry); seen.add(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
    const session = opts.branches === 'all' ? `${opts.session}#${leaf.id}` : opts.session;
    const branchSeq = { n: 0 };
    for (const e of chain.reverse()) if (e.type === 'message') yield* entryEvents(e, session, header.cwd, branchSeq, fmt);
  }
}
export async function treeDescribe(path: string): Promise<SessionIdentity | undefined> {
  // ponytail: bounded 16 KiB prefix; increase if oversized headers need discovery.
  const head = await Bun.file(path).slice(0, 16384).text();
  for (const line of head.split('\n').slice(0, 2)) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return undefined; }
    if (parsed?.type === 'title') continue;
    if (parsed?.type === 'session' && typeof parsed.id === 'string' && typeof parsed.cwd === 'string') return { id: parsed.id, repo: parsed.cwd };
    return undefined;
  }
}
