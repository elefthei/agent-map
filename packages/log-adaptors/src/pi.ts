import { homedir } from 'node:os';
import { join } from 'node:path';
import piRules from '../rules/pi.json';
import { parseTree, treeDescribe } from './tree';
import type { Rules } from './rules';
import type { SessionLogParser } from './types';
export const pi: SessionLogParser = {
  source: 'pi', label: 'Pi agent',
  dir: process.env.PI_SESSIONS_DIR ?? join(homedir(), '.pi/agent/sessions'),
  patterns: ['*/*.jsonl'], describe: treeDescribe,
  parse: (lines, opts) => parseTree(lines, { rules: piRules as Rules, origin: 'pi' }, opts),
};
