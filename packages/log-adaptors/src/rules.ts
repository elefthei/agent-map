import type { Op } from '@agent-map/core';
export interface Rule { op: Op; path: string; format?: 'hashline' }
export type Rules = Record<string, Rule>;
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
// Newlines collide with edge IDs; scheme:// paths are not files.
export const fileLike = (raw: string) => !raw.includes('\n') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
export function rulePaths(rule: Rule, args: unknown): string[] {
  const raw = pointerGet(args, rule.path);
  if (typeof raw !== 'string') return [];
  if (rule.format === 'hashline') return [...raw.matchAll(/^\[([^\]\n]+)#[0-9A-Fa-f]{4}\]$/gm)].map(m => m[1]);
  return [raw];
}
export async function* linesOf(text: string): AsyncIterable<string> {
  for (const line of text.split('\n')) if (line.trim()) yield line;
}
