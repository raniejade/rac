import crypto from 'node:crypto';
import path from 'node:path';

export const RAC_MARKER = '<!-- managed-by-rac -->';
export const FM_SENSITIVE_MARKER = '<!-- rac-frontmatter-sensitive -->';

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function splitCsv<T extends string>(value: string | undefined, fallback: readonly T[]): T[] {
  if (!value) return [...fallback];
  return value.split(',').map((s) => s.trim()).filter(Boolean) as T[];
}

export function rel(base: string, file: string): string {
  return path.relative(base, file) || '.';
}

export function assertNoTraversal(baseDir: string, candidateRelPath: string, label: string): string {
  const resolved = path.resolve(baseDir, candidateRelPath);
  const relToBase = path.relative(baseDir, resolved);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
    throw new Error(`${label} traversal rejected: ${candidateRelPath}`);
  }
  return resolved;
}

export function collectEnvVarsFromText(text: string): string[] {
  const vars = new Set<string>();
  for (const match of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
    vars.add(match[1]);
  }
  return [...vars].sort();
}
