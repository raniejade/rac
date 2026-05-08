import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { Kind, ManifestRecord, Target } from '../core/types.js';
import { MANAGED_JSONC_WARNING, sha256 } from '../core/util.js';

export type MergeContext = {
  existing: string | undefined;
  generated: string;
  ownedRecords: ManifestRecord[];
  nextRecords: ManifestRecord[];
  selectedKinds: Set<Kind>;
  phase: 'install' | 'clean';
};

export type MergeResult = { content: string; hash: string };

export interface MergeStrategy {
  applies(target: Target, relPath: string): boolean;
  merge(ctx: MergeContext): MergeResult;
}

function parseSelectorPath(selector: string): string[] | undefined {
  if (selector.startsWith('$.')) return selector.slice(2).split('.');
  if (!selector.startsWith('$')) return undefined;
  const segments: string[] = [];
  let i = 1;
  while (i < selector.length) {
    if (selector[i] !== '[') return undefined;
    const close = selector.indexOf(']', i);
    if (close === -1) return undefined;
    const inner = selector.slice(i + 1, close);
    try {
      const parsed = JSON.parse(inner);
      if (typeof parsed !== 'string') return undefined;
      segments.push(parsed);
    } catch {
      return undefined;
    }
    i = close + 1;
  }
  return segments;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  const parsed = parseJsonc(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function relevantRecords(records: ManifestRecord[], target: Target, kind: Kind): ManifestRecord[] {
  return records.filter((record) => record.target === target && record.kind === kind);
}

function selectorMcpId(selector: string, key: 'mcp' | 'mcpServers'): string | undefined {
  const segs = parseSelectorPath(selector);
  if (!segs || segs.length !== 2 || segs[0] !== key) return undefined;
  return segs[1];
}

function codexMcpIdFromSelector(selector: string): string | undefined {
  const match = /^mcp_servers\.(.+)$/.exec(selector);
  if (!match) return undefined;
  const segment = match[1];
  if (segment.startsWith('"') && segment.endsWith('"')) {
    try {
      const parsed = JSON.parse(segment);
      if (typeof parsed === 'string') return parsed;
    } catch { /* fall through */ }
  }
  return segment;
}

function inventoryEntries(record: ManifestRecord): string[] {
  return record.inventory[0]?.entries ?? [];
}

function configSelectorPaths(records: ManifestRecord[], target: Target): string[][] {
  const paths: string[][] = [];
  for (const record of relevantRecords(records, target, 'config')) {
    for (const entry of record.inventory) {
      const path = parseSelectorPath(entry.selector);
      if (path) paths.push(path);
    }
  }
  return paths;
}

function getAtPath(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    const obj = asObject(cursor);
    if (!Object.prototype.hasOwnProperty.call(obj, segment)) return undefined;
    cursor = obj[segment];
  }
  return cursor;
}

function setAtPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function deleteAtPath(root: Record<string, unknown>, path: string[]): void {
  const parents: Array<{ object: Record<string, unknown>; key: string }> = [];
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return;
    parents.push({ object: cursor, key: segment });
    cursor = next as Record<string, unknown>;
  }
  delete cursor[path[path.length - 1]];
  for (let i = parents.length - 1; i >= 0; i -= 1) {
    const { object, key } = parents[i];
    const child = object[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete object[key];
    } else {
      break;
    }
  }
}

function applyConfigSelectors(existing: Record<string, unknown>, generated: Record<string, unknown>, ctx: MergeContext, target: Target): void {
  if (!ctx.selectedKinds.has('config')) return;
  for (const path of configSelectorPaths(ctx.ownedRecords, target)) deleteAtPath(existing, path);
  for (const path of configSelectorPaths(ctx.nextRecords, target)) {
    const value = getAtPath(generated, path);
    if (value !== undefined) setAtPath(existing, path, value);
  }
}

function stableJsonObject(input: Record<string, unknown>, leadingKeys: string[] = []): string {
  const ordered: Record<string, unknown> = {};
  for (const key of leadingKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) ordered[key] = input[key];
  }
  for (const [key, value] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) {
    if (leadingKeys.includes(key)) continue;
    ordered[key] = value;
  }
  return JSON.stringify(ordered, null, 2);
}

export const codexConfigTomlStrategy: MergeStrategy = {
  applies(target, relPath) {
    return target === 'codex' && relPath === '.codex/config.toml';
  },
  merge(ctx) {
    let existing: Record<string, unknown> = {};
    if (ctx.existing && ctx.existing.trim().length > 0) {
      try {
        existing = parseToml(ctx.existing) as Record<string, unknown>;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`refusing to merge malformed codex config.toml: ${reason}; back up the file or rerun with --no-merge --force to clobber`);
      }
    }

    const prevMcpIds = new Set<string>();
    for (const record of relevantRecords(ctx.ownedRecords, 'codex', 'mcp')) {
      const id = codexMcpIdFromSelector(record.inventory[0]?.selector ?? '');
      if (id) prevMcpIds.add(id);
    }
    const nextMcpIds = new Set<string>();
    for (const record of relevantRecords(ctx.nextRecords, 'codex', 'mcp')) {
      const id = codexMcpIdFromSelector(record.inventory[0]?.selector ?? '');
      if (id) nextMcpIds.add(id);
    }

    const generatedTable = ctx.generated.trim().length > 0
      ? parseToml(ctx.generated) as Record<string, unknown>
      : {};
    const generatedMcps = asObject(generatedTable.mcp_servers);
    applyConfigSelectors(existing, generatedTable, ctx, 'codex');

    const mcpServers = asObject(existing.mcp_servers);
    if (ctx.selectedKinds.has('mcp')) {
      for (const id of prevMcpIds) delete mcpServers[id];
      for (const [id, value] of Object.entries(generatedMcps)) {
        if (nextMcpIds.has(id)) mcpServers[id] = value;
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      existing.mcp_servers = mcpServers;
    } else {
      delete existing.mcp_servers;
    }

    const serialized = stringifyToml(existing);
    const content = serialized.length > 0 ? `${serialized}\n` : '';
    return { content, hash: sha256(content) };
  }
};

export const claudeMcpJsonStrategy: MergeStrategy = {
  applies(target, relPath) {
    return target === 'claude' && (relPath === '.mcp.json' || relPath === '.claude.json');
  },
  merge(ctx) {
    const existing = parseJsonObject(ctx.existing);
    const generated = parseJsonObject(ctx.generated);
    applyConfigSelectors(existing, generated, ctx, 'claude');

    const prevIds = new Set<string>();
    for (const record of relevantRecords(ctx.ownedRecords, 'claude', 'mcp')) {
      const id = selectorMcpId(record.inventory[0]?.selector ?? '', 'mcpServers');
      if (id) prevIds.add(id);
    }
    const nextIds = new Set<string>();
    for (const record of relevantRecords(ctx.nextRecords, 'claude', 'mcp')) {
      const id = selectorMcpId(record.inventory[0]?.selector ?? '', 'mcpServers');
      if (id) nextIds.add(id);
    }

    const mcpServers = asObject(existing.mcpServers);
    const generatedMcps = asObject(generated.mcpServers);

    if (ctx.selectedKinds.has('mcp')) {
      for (const id of prevIds) delete mcpServers[id];
      for (const [id, value] of Object.entries(generatedMcps)) {
        if (nextIds.has(id)) mcpServers[id] = value;
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      existing.mcpServers = mcpServers;
    } else {
      delete existing.mcpServers;
    }

    const content = `${stableJsonObject(existing, ['mcpServers'])}\n`;
    return { content, hash: sha256(content) };
  }
};

export const claudeSettingsDenyStrategy: MergeStrategy = {
  applies(target, relPath) {
    return target === 'claude' && relPath === '.claude/settings.json';
  },
  merge(ctx) {
    const existing = parseJsonObject(ctx.existing);
    const generated = parseJsonObject(ctx.generated);
    applyConfigSelectors(existing, generated, ctx, 'claude');

    const prevEntries = new Set<string>();
    for (const record of relevantRecords(ctx.ownedRecords, 'claude', 'rule')) {
      for (const entry of inventoryEntries(record)) prevEntries.add(entry);
    }
    const nextEntries = new Set<string>();
    for (const record of relevantRecords(ctx.nextRecords, 'claude', 'rule')) {
      for (const entry of inventoryEntries(record)) nextEntries.add(entry);
    }

    const permissions = asObject(existing.permissions);
    const existingDeny = Array.isArray(permissions.deny) ? permissions.deny.filter((entry): entry is string => typeof entry === 'string') : [];

    let merged: string[];
    if (ctx.selectedKinds.has('rule')) {
      const filtered = existingDeny.filter((entry) => !prevEntries.has(entry) || nextEntries.has(entry));
      merged = [...filtered];
      for (const entry of [...nextEntries].sort((a, b) => a.localeCompare(b))) {
        if (!merged.includes(entry)) merged.push(entry);
      }
    } else {
      merged = existingDeny;
    }

    if (merged.length > 0) {
      permissions.deny = merged;
      existing.permissions = permissions;
    } else if (Object.keys(permissions).filter((k) => k !== 'deny').length > 0) {
      delete permissions.deny;
      existing.permissions = permissions;
    } else {
      delete existing.permissions;
    }

    const content = `${stableJsonObject(existing, ['permissions'])}\n`;
    return { content, hash: sha256(content) };
  }
};

export const opencodeSharedJsoncStrategy: MergeStrategy = {
  applies(target, relPath) {
    return target === 'opencode' && (relPath === '.opencode/opencode.jsonc' || relPath === 'opencode/opencode.jsonc');
  },
  merge(ctx) {
    const existing = parseJsonObject(ctx.existing);
    const generated = parseJsonObject(ctx.generated);
    applyConfigSelectors(existing, generated, ctx, 'opencode');

    const prevMcpIds = new Set<string>();
    for (const record of relevantRecords(ctx.ownedRecords, 'opencode', 'mcp')) {
      const id = selectorMcpId(record.inventory[0]?.selector ?? '', 'mcp');
      if (id) prevMcpIds.add(id);
    }
    const nextMcpIds = new Set<string>();
    for (const record of relevantRecords(ctx.nextRecords, 'opencode', 'mcp')) {
      const id = selectorMcpId(record.inventory[0]?.selector ?? '', 'mcp');
      if (id) nextMcpIds.add(id);
    }

    const mcp = asObject(existing.mcp);
    const generatedMcp = asObject(generated.mcp);
    if (ctx.selectedKinds.has('mcp')) {
      for (const id of prevMcpIds) delete mcp[id];
      for (const [id, value] of Object.entries(generatedMcp)) {
        if (nextMcpIds.has(id)) mcp[id] = value;
      }
    }
    if (Object.keys(mcp).length > 0) existing.mcp = mcp;
    else delete existing.mcp;

    const prevBash = new Set<string>();
    for (const record of relevantRecords(ctx.ownedRecords, 'opencode', 'rule')) {
      for (const entry of inventoryEntries(record)) prevBash.add(entry);
    }
    const nextBash = new Set<string>();
    for (const record of relevantRecords(ctx.nextRecords, 'opencode', 'rule')) {
      for (const entry of inventoryEntries(record)) nextBash.add(entry);
    }

    const permission = asObject(existing.permission);
    const generatedPermission = asObject(generated.permission);
    const generatedBash = asObject(generatedPermission.bash);
    const bash = asObject(permission.bash);
    if (ctx.selectedKinds.has('rule')) {
      for (const cmd of prevBash) delete bash[cmd];
      for (const cmd of nextBash) {
        bash[cmd] = generatedBash[cmd] ?? 'deny';
      }
    }
    if (Object.keys(bash).length > 0) {
      permission.bash = bash;
      existing.permission = permission;
    } else if (Object.keys(permission).filter((k) => k !== 'bash').length > 0) {
      delete permission.bash;
      existing.permission = permission;
    } else {
      delete existing.permission;
    }

    const content = `${MANAGED_JSONC_WARNING}\n${stableJsonObject(existing, ['mcp', 'permission'])}\n`;
    return { content, hash: sha256(content) };
  }
};

const STRATEGIES: MergeStrategy[] = [
  codexConfigTomlStrategy,
  claudeMcpJsonStrategy,
  claudeSettingsDenyStrategy,
  opencodeSharedJsoncStrategy
];

export function pickMergeStrategy(target: Target, relPath: string): MergeStrategy | undefined {
  return STRATEGIES.find((strategy) => strategy.applies(target, relPath));
}
