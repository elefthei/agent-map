import type { FileEvent, Source } from '@agent-map/core';
export interface ParseOptions { session: string; branches: 'active' | 'all'; stream: boolean }
export interface SessionIdentity { id: string; repo: string }
export interface SessionLogParser {
  readonly source: Source;
  readonly label: string;
  readonly dir?: string;
  readonly patterns: readonly string[];
  describe(path: string): Promise<SessionIdentity | undefined>;
  parse(lines: AsyncIterable<string>, opts: ParseOptions): AsyncIterable<FileEvent>;
}
