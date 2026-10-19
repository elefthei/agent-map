import { z } from 'zod';
import type { FileEntry, SessionHeader, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import type { ToolCall } from '@earendil-works/pi-ai';
import piRulesJSON from '../rules/pi.json';
import copilotRulesJSON from '../rules/copilot.json';
import type { FileEvent, Op } from './types';
export interface Rule { op: Op; path: string }
export type Rules = Record<string, Rule>;
const piRules = piRulesJSON as Rules, copilotRules = copilotRulesJSON as Rules;
export function matchRule(rules: Rules, tool: string): Rule | undefined {
  if (Object.hasOwn(rules, tool)) return rules[tool];
  return Object.entries(rules).find(([key]) => key.endsWith('*') && tool.startsWith(key.slice(0, -1)))?.[1];
}
export function pointerGet(obj: unknown, ptr: string): unknown {
  if (ptr === '') return obj;
  if (!ptr.startsWith('/')) return undefined;
  for (const key of ptr.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (typeof obj !== 'object' || obj === null || !Object.hasOwn(obj, key)) return undefined;
    obj = (obj as Record<string, unknown>)[key];
  }
  return obj;
}
export function normalizePath(raw: string, cwd: string): string {
  raw = raw.replace(/^(\.\/)+/, '');
  return cwd && raw.startsWith(cwd + '/') ? raw.slice(cwd.length + 1) : raw;
}
// Newlines would collide with the graph's edge separator.
const validPath = (raw: unknown): raw is string => typeof raw === 'string' && !raw.includes('\n');
function entryEvents(entry: SessionMessageEntry, session: string, cwd: string, seq: { n: number }): FileEvent[] {
  if (entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) return [];
  const out: FileEvent[] = [];
  for (const item of entry.message.content) {
    if (item.type !== 'toolCall') continue;
    const c: ToolCall = item, rule = matchRule(piRules, c.name);
    if (!rule) continue;
    const raw = pointerGet(c.arguments, rule.path);
    if (!validPath(raw)) continue;
    // ponytail: no isError filtering; join on toolResult if phantom files matter.
    out.push({ session, seq: seq.n++, ts: Date.parse(entry.timestamp), op: rule.op, path: normalizePath(raw, cwd), tool: c.name, origin: 'pi' });
  }
  return out;
}
export async function* parsePi(lines: AsyncIterable<string>, opts: { branches?: 'active' | 'all'; stream?: boolean } = {}): AsyncIterable<FileEvent> {
  let header: SessionHeader | undefined;
  const entries: Exclude<FileEntry, SessionHeader>[] = [], seq = { n: 0 };
  for await (const line of lines) {
    let parsed: FileEntry;
    try { parsed = JSON.parse(line); } catch {
      if (!header) throw Error('not a pi session file');
      continue;
    }
    if (!header) {
      if (parsed?.type !== 'session' || typeof parsed.id !== 'string' || typeof parsed.cwd !== 'string') throw Error('not a pi session file');
      header = parsed;
      continue;
    }
    if (!parsed || typeof parsed.id !== 'string' || parsed.type === 'session') continue;
    if (opts.stream) {
      if (parsed.type === 'message') yield* entryEvents(parsed, header.id, header.cwd, seq);
    } else entries.push(parsed);
  }
  if (!header) throw Error('not a pi session file');
  if (opts.stream || !entries.length) return;
  const byId = new Map(entries.map(e => [e.id, e]));
  const parents = new Set(entries.map(e => e.parentId));
  const leaves = opts.branches === 'all' ? entries.filter(e => !parents.has(e.id)) : entries.slice(-1);
  for (const leaf of leaves) {
    const chain: typeof entries = [], seen = new Set<string>();
    let entry: typeof leaf | undefined = leaf;
    while (entry && !seen.has(entry.id)) { chain.push(entry); seen.add(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
    const session = opts.branches === 'all' ? `${header.id}#${leaf.id}` : header.id;
    const branchSeq = { n: 0 };
    for (const e of chain.reverse()) if (e.type === 'message') yield* entryEvents(e, session, header.cwd, branchSeq);
  }
}
const Envelope = z.object({ type: z.string(), timestamp: z.string().optional(), data: z.unknown() }).passthrough();
const StartData = z.object({ context: z.object({ cwd: z.string() }).passthrough().optional() }).passthrough();
const ToolStart = z.object({ toolName: z.string(), arguments: z.unknown().optional() }).passthrough();
export async function* parseCopilot(lines: AsyncIterable<string>, sessionId: string): AsyncIterable<FileEvent> {
  let cwd = '', seq = 0;
  for await (const line of lines) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const result = Envelope.safeParse(raw);
    if (!result.success) continue;
    const e = result.data;
    if (e.type === 'session.start') { const start = StartData.safeParse(e.data); if (start.success) cwd = start.data.context?.cwd ?? ''; }
    if (e.type !== 'tool.execution_start') continue;
    const start = ToolStart.safeParse(e.data);
    if (!start.success) continue;
    const rule = matchRule(copilotRules, start.data.toolName);
    if (!rule) continue;
    const path = pointerGet(start.data.arguments, rule.path);
    if (!validPath(path)) continue;
    yield { session: sessionId, seq: seq++, ts: e.timestamp ? Date.parse(e.timestamp) : undefined, op: rule.op, path: normalizePath(path, cwd), tool: start.data.toolName, origin: 'copilot' };
  }
}
export async function* parseTrace(lines: AsyncIterable<string>, session: string): AsyncIterable<FileEvent> {
  let seq = 0;
  for await (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || (o.op !== 'read' && o.op !== 'write') || !validPath(o.path)) continue;
    yield { session, seq: seq++, ts: typeof o.ts === 'number' ? o.ts : undefined, op: o.op, path: o.path, tool: typeof o.tool === 'string' ? o.tool : 'trace', origin: 'trace' };
  }
}
export async function* linesOf(text: string): AsyncIterable<string> {
  for (const line of text.split('\n')) if (line.trim()) yield line;
}
