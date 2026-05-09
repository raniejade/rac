import crypto from 'node:crypto';
import path from 'node:path';

export const MANAGED_WARNING_TEXT = 'DO NOT EDIT; managed by rac';
export const MANAGED_MARKDOWN_WARNING = `<!-- ${MANAGED_WARNING_TEXT} -->`;
export const MANAGED_TOML_WARNING = `# ${MANAGED_WARNING_TEXT}`;
export const MANAGED_JSONC_WARNING = `// ${MANAGED_WARNING_TEXT}`;

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

export function expandRulePattern(pattern: Array<string | string[]>): string[][] {
  return pattern
    .map((segment) => Array.isArray(segment) ? segment : [segment])
    .reduce<string[][]>((acc, options) => {
      const next: string[][] = [];
      for (const base of acc) for (const option of options) next.push([...base, option]);
      return next;
    }, [[]]);
}

export function bracketSelectorPath(selector: string): string[] {
  if (!selector.startsWith('$')) return [selector];
  const out: string[] = [];
  let i = 1;
  while (i < selector.length) {
    if (selector[i] !== '[') return [selector];
    const close = selector.indexOf(']', i);
    if (close < 0) return [selector];
    const parsed = JSON.parse(selector.slice(i + 1, close)) as unknown;
    if (typeof parsed !== 'string') return [selector];
    out.push(parsed);
    i = close + 1;
  }
  return out;
}

export function selectorPath(selector: string): string[] {
  if (selector.startsWith('$[')) {
    const segments: string[] = [];
    let i = 1;
    while (i < selector.length) {
      const close = selector.indexOf(']', i);
      if (selector[i] !== '[' || close < 0) return [selector];
      const segment = JSON.parse(selector.slice(i + 1, close)) as unknown;
      if (typeof segment !== 'string') return [selector];
      segments.push(segment);
      i = close + 1;
    }
    return segments;
  }
  if (selector.startsWith('$.')) return selector.slice(2).split('.');
  const parts: string[] = [];
  let current = '';
  let i = 0;
  while (i < selector.length) {
    if (selector[i] === '.') {
      if (current) parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (selector[i] === '"') {
      let end = i + 1;
      while (end < selector.length) {
        if (selector[end] === '"' && selector[end - 1] !== '\\') break;
        end += 1;
      }
      if (end >= selector.length) return [selector];
      const quoted = selector.slice(i, end + 1);
      parts.push(JSON.parse(quoted) as string);
      i = end + 1;
      if (selector[i] === '.') i += 1;
      current = '';
      continue;
    }
    current += selector[i];
    i += 1;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [selector];
}

export function selectorPathsOverlap(first: string[], second: string[]): boolean {
  const limit = Math.min(first.length, second.length);
  for (let i = 0; i < limit; i += 1) {
    if (first[i] !== second[i]) return false;
  }
  return true;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return undefined;
  return value as Record<string, unknown>;
}
