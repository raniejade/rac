import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  asRecord,
  assertNoTraversal,
  collectEnvVarsFromText,
  expandRulePattern,
  jsonPathBracketSelector,
  rel,
  resolveContainedPath,
  sha256,
  splitCsv,
  tomlQuotedKeySegment
} from '../src/core/util.js';

describe('sha256', () => {
  it('is deterministic for string input', () => {
    const h1 = sha256('hello');
    const h2 = sha256('hello');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('is deterministic for Buffer input', () => {
    const buf = Buffer.from('hello');
    const h1 = sha256(buf);
    const h2 = sha256(buf);
    expect(h1).toBe(h2);
  });

  it('different inputs produce different hashes', () => {
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  it('string and Buffer of same bytes produce same hash', () => {
    expect(sha256('test')).toBe(sha256(Buffer.from('test')));
  });
});

describe('splitCsv', () => {
  it('returns fallback for undefined', () => {
    expect(splitCsv(undefined, ['a', 'b'] as const)).toEqual(['a', 'b']);
  });

  it('returns fallback for empty string', () => {
    expect(splitCsv('', ['a'] as const)).toEqual(['a']);
  });

  it('handles whitespace around values', () => {
    expect(splitCsv(' a , b ', [] as const)).toEqual(['a', 'b']);
  });

  it('handles trailing comma', () => {
    expect(splitCsv('a,b,', [] as const)).toEqual(['a', 'b']);
  });

  it('preserves order', () => {
    expect(splitCsv('z,a,m', [] as const)).toEqual(['z', 'a', 'm']);
  });
});

describe('rel', () => {
  it('same path returns dot', () => {
    expect(rel('/a/b', '/a/b')).toBe('.');
  });

  it('nested path returns relative', () => {
    expect(rel('/a', '/a/b/c')).toBe(path.join('b', 'c'));
  });

  it('sibling path is dotdot prefixed', () => {
    expect(rel('/a/b', '/a/c')).toBe(path.join('..', 'c'));
  });
});

describe('assertNoTraversal', () => {
  it('contained path is accepted', () => {
    const result = assertNoTraversal('/base', 'sub/file.txt', 'test');
    expect(result).toBe(path.resolve('/base', 'sub/file.txt'));
  });

  it('dotdot path is rejected', () => {
    expect(() => assertNoTraversal('/base', '../outside', 'test')).toThrow('traversal rejected');
  });

  it('absolute candidate that escapes base is rejected', () => {
    expect(() => assertNoTraversal('/base', '/etc/passwd', 'test')).toThrow('traversal rejected');
  });
});

describe('tomlQuotedKeySegment', () => {
  it('escapes double quotes', () => {
    const result = tomlQuotedKeySegment('a"b');
    expect(result).toBe('"a\\"b"');
  });

  it('escapes backslash', () => {
    const result = tomlQuotedKeySegment('a\\b');
    expect(result).toBe('"a\\\\b"');
  });

  it('round-trips via JSON.parse', () => {
    const key = 'a"b\\c';
    const segment = tomlQuotedKeySegment(key);
    expect(JSON.parse(segment)).toBe(key);
  });
});

describe('jsonPathBracketSelector', () => {
  it('single segment', () => {
    expect(jsonPathBracketSelector(['foo'])).toBe('$["foo"]');
  });

  it('multi-segment', () => {
    expect(jsonPathBracketSelector(['a', 'b', 'c'])).toBe('$["a"]["b"]["c"]');
  });

  it('segment containing bracket character', () => {
    expect(jsonPathBracketSelector(['a]b'])).toBe('$["a]b"]');
  });
});

describe('resolveContainedPath', () => {
  it('rejects absolute path', () => {
    expect(() => resolveContainedPath('/base', '/etc/passwd', 'test')).toThrow('absolute path');
  });

  it('rejects backslash separator', () => {
    expect(() => resolveContainedPath('/base', 'sub\\file', 'test')).toThrow('backslash');
  });

  it('rejects dotdot path that escapes root', () => {
    expect(() => resolveContainedPath('/base', '../outside', 'test')).toThrow('path escapes root');
  });

  it('accepts contained relative path', () => {
    const result = resolveContainedPath('/base', 'sub/file.txt', 'test');
    expect(result).toBe(path.resolve('/base', 'sub/file.txt'));
  });
});

describe('collectEnvVarsFromText', () => {
  it('collects unique sorted uppercase vars from text', () => {
    expect(collectEnvVarsFromText('${FOO} ${BAR} ${FOO}')).toEqual(['BAR', 'FOO']);
  });

  it('ignores lowercase var references', () => {
    expect(collectEnvVarsFromText('${lowercase}')).toEqual([]);
  });

  it('ignores bare dollar vars without braces', () => {
    expect(collectEnvVarsFromText('$FOO')).toEqual([]);
  });
});

describe('expandRulePattern', () => {
  it('scalar segment and array segment produce Cartesian product', () => {
    const result = expandRulePattern(['git', ['push', 'pull']]);
    expect(result).toEqual([['git', 'push'], ['git', 'pull']]);
  });

  it('single-option array produces one row', () => {
    const result = expandRulePattern([['only']]);
    expect(result).toEqual([['only']]);
  });

  it('all scalars produces single row', () => {
    const result = expandRulePattern(['a', 'b', 'c']);
    expect(result).toEqual([['a', 'b', 'c']]);
  });

  it('returns no rows when an options segment is empty', () => {
    expect(expandRulePattern([['a'], []])).toEqual([]);
  });
});

describe('asRecord', () => {
  it('rejects null', () => {
    expect(asRecord(null)).toBeUndefined();
  });

  it('rejects primitives', () => {
    expect(asRecord(42)).toBeUndefined();
    expect(asRecord('string')).toBeUndefined();
    expect(asRecord(true)).toBeUndefined();
  });

  it('rejects arrays', () => {
    expect(asRecord([1, 2, 3])).toBeUndefined();
  });

  it('rejects Date', () => {
    expect(asRecord(new Date())).toBeUndefined();
  });

  it('returns same reference for plain object', () => {
    const obj = { a: 1, b: 'two' };
    expect(asRecord(obj)).toBe(obj);
  });
});
