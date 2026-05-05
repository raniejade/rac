import path from 'node:path';

import type { Scope } from './types.js';

export function sourceRoot(scope: Scope, cwd: string): string {
  return scope === 'project' ? path.join(cwd, '.airc') : path.join(process.env.HOME || '', '.airc');
}
