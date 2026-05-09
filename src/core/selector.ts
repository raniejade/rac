import { jsonPathBracketSelector } from './util.js';

/**
 * Parse a JSONPath bracket-notation selector (e.g. `$["key1"]["key2"]`) into
 * an array of path segments (without the leading `$`).
 *
 * - `parseSelector('$')` returns `[]`.
 * - `parseSelector('$.a.b')` is NOT supported; callers must use bracket notation.
 *   However, as a convenience, dot-notation selectors are handled by delegating
 *   to a simple split (matching existing JSONPath semantics for simple keys).
 * - Non-`$` selectors throw — use `parseCodexTomlSelector` for Codex TOML paths.
 *
 * The implementation deliberately does NOT use `JSONPath.toPathArray` because
 * that method has a known bug where it does not properly unescape JSON-encoded
 * strings in bracket notation (e.g. `$["dot id \"x\""]` returns the literal
 * backslashes rather than the unescaped string).  We use our own parser backed
 * by `JSON.parse` for correct RFC-conformant unescaping.
 */
export function parseSelector(selector: string): string[] {
  if (!selector.startsWith('$')) {
    throw new Error(`not a JSONPath selector: ${selector}`);
  }
  if (selector === '$') return [];

  // Dot-notation: `$.a.b.c`
  if (selector.startsWith('$.')) {
    return selector.slice(2).split('.');
  }

  // Bracket-notation: `$["key1"]["key2"]`
  if (!selector.startsWith('$[')) {
    throw new Error(`not a JSONPath selector: ${selector}`);
  }

  const out: string[] = [];
  let i = 1; // skip '$'
  while (i < selector.length) {
    if (selector[i] !== '[') {
      throw new Error(`malformed JSONPath selector (expected '[' at position ${i}): ${selector}`);
    }
    i += 1; // skip '['
    if (i >= selector.length || selector[i] !== '"') {
      throw new Error(`malformed JSONPath selector (expected '"' at position ${i}): ${selector}`);
    }

    // Scan the JSON string: start at the opening `"`, find the matching closing `"`
    // respecting backslash escapes.
    const stringStart = i;
    i += 1; // skip opening `"`
    while (i < selector.length) {
      if (selector[i] === '\\') {
        i += 2; // skip escape sequence
        continue;
      }
      if (selector[i] === '"') {
        break; // found closing `"`
      }
      i += 1;
    }
    if (i >= selector.length) {
      throw new Error(`malformed JSONPath selector (unterminated string): ${selector}`);
    }
    i += 1; // skip closing `"`
    if (i >= selector.length || selector[i] !== ']') {
      throw new Error(`malformed JSONPath selector (expected ']' at position ${i}): ${selector}`);
    }
    const jsonStr = selector.slice(stringStart, i); // includes the surrounding `"`
    const segment = JSON.parse(jsonStr) as string;
    out.push(segment);
    i += 1; // skip ']'
  }
  return out;
}

/**
 * Try to parse a JSONPath selector; returns `undefined` on any error.
 * Replaces the looser `parseSelectorPath` in `merge-strategies.ts`.
 */
export function tryParseSelector(selector: string): string[] | undefined {
  try {
    return parseSelector(selector);
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the selector refers to the entire file (bare `$`).
 */
export function isWholeFileSelector(selector: string): boolean {
  return selector === '$';
}

/**
 * Format path segments back into a JSONPath bracket-notation selector.
 * Re-exports `jsonPathBracketSelector` to keep emitted selectors byte-identical
 * to existing manifests.
 */
export function formatSelector(pathSegments: string[]): string {
  return jsonPathBracketSelector(pathSegments);
}

/**
 * Parse a Codex TOML key-path selector (e.g. `mcp_servers."dot.id"` or
 * `mcp_servers.foo`) into an array of path segments.
 *
 * This is NOT JSONPath; it is the TOML-specific dotted-key form used by the
 * Codex adapter.  Port of the third (non-`$`) branch of `selectorToPath` in
 * `src/adapters/target-adapters.ts`.
 */
export function parseCodexTomlSelector(selector: string): string[] {
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
      if (i < selector.length && selector[i] === '.') i += 1;
      current = '';
      continue;
    }
    current += selector[i];
    i += 1;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [selector];
}

/**
 * Returns true if `first` and `second` path arrays overlap, i.e. one is a
 * prefix of the other (or they are equal).  Used to detect selector conflicts.
 */
export function pathsOverlap(first: string[], second: string[]): boolean {
  const limit = Math.min(first.length, second.length);
  for (let i = 0; i < limit; i += 1) {
    if (first[i] !== second[i]) return false;
  }
  return true;
}
