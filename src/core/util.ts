import crypto from 'node:crypto';
import path from 'node:path';

export const MANAGED_WARNING_TEXT = 'DO NOT EDIT; managed by rac';
export const MANAGED_MARKDOWN_WARNING = `<!-- ${MANAGED_WARNING_TEXT} -->`;
export const MANAGED_TOML_WARNING = `# ${MANAGED_WARNING_TEXT}`;
export const MANAGED_JSONC_WARNING = `// ${MANAGED_WARNING_TEXT}`;
export const LEGACY_MARKERS = ['<!-- managed-by-rac -->', '<!-- rac-frontmatter-sensitive -->'];

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

export function normalizeDefinitionId(kind: string, rawId: string): string {
  if (rawId !== rawId.trim()) throw new Error(`invalid ${kind} id: leading/trailing whitespace is not allowed: ${rawId}`);
  const normalized = rawId.normalize('NFC');
  if (!normalized.trim()) throw new Error(`invalid ${kind} id: empty after trimming`);
  if (normalized === '.' || normalized === '..') throw new Error(`invalid ${kind} id: ${normalized}`);
  if (normalized.includes('/') || normalized.includes('\\')) throw new Error(`invalid ${kind} id: path separators are not allowed: ${normalized}`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`invalid ${kind} id: control characters are not allowed`);
  return normalized;
}

export function tomlQuotedKeySegment(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function jsonPathBracketSelector(pathSegments: string[]): string {
  return `$${pathSegments.map((segment) => `[${JSON.stringify(segment)}]`).join('')}`;
}

export function resolveContainedPath(root: string, candidateRelPath: string, label: string): string {
  if (path.isAbsolute(candidateRelPath)) {
    throw new Error(`${label} rejected: absolute path is not allowed: ${candidateRelPath}`);
  }
  if (candidateRelPath.includes('\\')) {
    throw new Error(`${label} rejected: backslash path separators are not allowed: ${candidateRelPath}`);
  }
  const resolved = path.resolve(root, candidateRelPath);
  const relToRoot = path.relative(root, resolved);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`${label} rejected: path escapes root: ${candidateRelPath}`);
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
