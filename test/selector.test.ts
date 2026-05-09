import { describe, expect, it } from 'vitest';

import { formatSelector, parseCodexTomlSelector, parseSelector, pathsOverlap, tryParseSelector } from '../src/core/selector.js';
import { jsonPathBracketSelector } from '../src/core/util.js';

describe('selector', () => {
  describe('parseSelector', () => {
    // Parity gate: these are the literal expected arrays that correspond to
    // correct JSONPath parsing of the selectors produced by the system.
    // The dot-notation selectors ($.permissions.*) split on '.', and the
    // bracket-notation selectors (e.g. $["mcpServers"][...]) decode JSON strings.
    it('$.permissions.deny returns correct path array', () => {
      expect(parseSelector('$.permissions.deny')).toEqual(['permissions', 'deny']);
    });

    it('$.permissions.allow returns correct path array', () => {
      expect(parseSelector('$.permissions.allow')).toEqual(['permissions', 'allow']);
    });

    it('$.permission.bash returns correct path array', () => {
      expect(parseSelector('$.permission.bash')).toEqual(['permission', 'bash']);
    });

    it('$["mcpServers"]["project-rules"] returns correct path array', () => {
      expect(parseSelector('$["mcpServers"]["project-rules"]')).toEqual(['mcpServers', 'project-rules']);
    });

    it('$["mcpServers"]["dot id \\"x\\".日本語"] returns correct path array', () => {
      expect(parseSelector('$["mcpServers"]["dot id \\"x\\".日本語"]')).toEqual(['mcpServers', 'dot id "x".日本語']);
    });

    it('$["mcp"]["a-remote"] returns correct path array', () => {
      expect(parseSelector('$["mcp"]["a-remote"]')).toEqual(['mcp', 'a-remote']);
    });

    it('$["mcp"]["dot id \\"x\\".日本語"] returns correct path array', () => {
      expect(parseSelector('$["mcp"]["dot id \\"x\\".日本語"]')).toEqual(['mcp', 'dot id "x".日本語']);
    });

    it('$["model"] returns correct path array', () => {
      expect(parseSelector('$["model"]')).toEqual(['model']);
    });

    it('$["model_reasoning_effort"] returns correct path array', () => {
      expect(parseSelector('$["model_reasoning_effort"]')).toEqual(['model_reasoning_effort']);
    });

    it('$["features"]["multi_agent"] returns correct path array', () => {
      expect(parseSelector('$["features"]["multi_agent"]')).toEqual(['features', 'multi_agent']);
    });

    it('$ returns []', () => {
      expect(parseSelector('$')).toEqual([]);
    });

    it('$["abc]def"] returns [\'abc]def\'] (closing bracket in key)', () => {
      expect(parseSelector('$["abc]def"]')).toEqual(['abc]def']);
    });

    it('mcp_servers.foo throws (non-$ selector)', () => {
      expect(() => parseSelector('mcp_servers.foo')).toThrow('not a JSONPath selector');
    });

    it('$[malformed throws on bad bracket notation', () => {
      expect(() => parseSelector('$[malformed')).toThrow();
    });
  });

  describe('tryParseSelector', () => {
    it('returns undefined for malformed selector', () => {
      expect(tryParseSelector('$[malformed')).toBeUndefined();
    });

    it('returns path array for valid selector', () => {
      expect(tryParseSelector('$["model"]')).toEqual(['model']);
    });

    it('returns undefined for non-$ selector', () => {
      expect(tryParseSelector('mcp_servers.foo')).toBeUndefined();
    });
  });

  describe('parseCodexTomlSelector', () => {
    it('mcp_servers."dot.id" returns [\'mcp_servers\', \'dot.id\']', () => {
      expect(parseCodexTomlSelector('mcp_servers."dot.id"')).toEqual(['mcp_servers', 'dot.id']);
    });

    it('mcp_servers.foo returns [\'mcp_servers\', \'foo\']', () => {
      expect(parseCodexTomlSelector('mcp_servers.foo')).toEqual(['mcp_servers', 'foo']);
    });
  });

  describe('formatSelector', () => {
    it('formats path segments into bracket notation', () => {
      expect(formatSelector(['a-b', 'c'])).toBe('$["a-b"]["c"]');
    });

    it('is byte-identical to jsonPathBracketSelector', () => {
      const segments = ['a-b', 'c'];
      expect(formatSelector(segments)).toBe(jsonPathBracketSelector(segments));
    });
  });

  describe('pathsOverlap', () => {
    it('overlap when one is a prefix of the other', () => {
      expect(pathsOverlap(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
    });

    it('no overlap when paths diverge', () => {
      expect(pathsOverlap(['a', 'b'], ['a', 'c'])).toBe(false);
    });

    it('equal paths overlap', () => {
      expect(pathsOverlap(['a', 'b'], ['a', 'b'])).toBe(true);
    });

    it('empty paths overlap', () => {
      expect(pathsOverlap([], ['a', 'b'])).toBe(true);
    });
  });
});
