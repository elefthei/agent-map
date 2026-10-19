import { homedir } from 'node:os';
import { join } from 'node:path';
import ompRules from '../rules/omp.json';
import { parseTree, treeDescribe } from './tree';
import type { Rules } from './rules';
import type { SessionLogParser } from './types';
export const stripSelector = (raw: string) => raw.replace(/:[^/]*$/, '');
export const omp: SessionLogParser = {
  source: 'omp', label: 'OMP',
  dir: process.env.OMP_SESSIONS_DIR ?? join(homedir(), '.omp/agent/sessions'),
  patterns: ['*/*.jsonl'], describe: treeDescribe,
  parse: (lines, opts) => parseTree(lines, { rules: ompRules as Rules, origin: 'omp', path: stripSelector }, opts),
};
