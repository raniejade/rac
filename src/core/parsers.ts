import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fg from 'fast-glob';
import { parse } from 'smol-toml';
import { z } from 'zod';

import { findLockEntry, loadPackLock, writePackLock } from './pack-lock.js';
import { parseSelector, pathsOverlap } from './selector.js';
import type { AgentDef, McpDef, PackLockEntry, PackLockFile, PackOverride, PackRuntime, PackSpec, RuleCommandItem, RuleDecision, RuleDef, SkillDef, Target, VendorConfigDef } from './types.js';
import { asRecord, collectEnvVarsFromText, jsonPathBracketSelector, normalizeDefinitionId } from './util.js';

const PACK_ID_RE = /^[A-Za-z0-9._-]+$/;
const GITHUB_REPO_RE = /^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const REF_RE = /^\S+$/;

const agentSchema = z.object({ id: z.string().min(1), name: z.string().optional(), description: z.string().optional(), instructions: z.string().min(1), tools: z.array(z.string()).optional(), vendor: z.record(z.unknown()).optional() });
const skillSchema = z.object({ name: z.string().optional(), description: z.string().min(1), vendor: z.record(z.unknown()).optional() });
const mcpSchema = z.object({ id: z.string().min(1), command: z.string().optional(), args: z.array(z.string()).optional(), url: z.string().optional(), startup_timeout_ms: z.number().int().positive().optional(), vendor: z.record(z.unknown()).optional(), env: z.record(z.string(), z.string()).optional(), env_forward: z.array(z.string().min(1)).optional() }).superRefine((v, ctx) => {
  const hasLocal = !!v.command;
  const hasRemote = !!v.url;
  if (!hasLocal && !hasRemote) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp requires local command OR remote url' });
  if (hasLocal && hasRemote) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp cannot define both local and remote transport' });
  if (v.env && hasRemote) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp env is only allowed on local transport' });
  if (v.env_forward && v.env_forward.length > 0 && hasRemote) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp env_forward is only allowed on local transport' });
  if (v.env && v.env_forward) {
    for (const k of v.env_forward) {
      if (k in v.env) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `mcp env key "${k}" cannot also appear in env_forward` });
    }
  }
});
const ruleSchema = z.object({ id: z.string().min(1), decision: z.string(), justification: z.string(), command: z.array(z.union([z.string(), z.array(z.string())])), append_wildcard: z.boolean().optional() });
const VENDOR_CONFIG_TARGETS = ['claude', 'codex', 'opencode'] as const;
const RULE_DECISIONS = new Set<string>(['allow', 'forbidden']);

function parseTomlOrThrow(file: string, raw: string): Record<string, unknown> {
  try { return parse(raw) as Record<string, unknown>; }
  catch (error) { throw new Error(`invalid TOML: ${file}: ${String((error as Error).message || error)}`); }
}

function cacheRoot(): string {
  return process.env.RAC_CACHE_DIR || path.join(os.homedir(), '.cache', 'rac');
}

function repoToGitUrl(repo: string): string {
  const match = GITHUB_REPO_RE.exec(repo);
  if (!match) throw new Error(`invalid pack repo; expected github:owner/repo: ${repo}`);
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

export function validatePackSpec(spec: PackSpec): void {
  if (!PACK_ID_RE.test(spec.id)) throw new Error(`invalid pack id; use ASCII path-safe letters/numbers/./_/-: ${spec.id}`);
  if (spec.id === 'project') throw new Error('invalid pack id; project is reserved for the local project pack');
  if (!GITHUB_REPO_RE.test(spec.repo)) throw new Error(`invalid pack repo; expected github:owner/repo: ${spec.repo}`);
  if (!REF_RE.test(spec.ref)) throw new Error(`invalid pack ref: ${spec.ref}`);
}

export type GitRunner = (args: string[], cwd?: string) => Promise<{ stdout: string }>;

export function defaultGitRunner(): GitRunner {
  return async (args, cwd) => {
    return new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      child.on('error', (error) => {
        const asNodeErr = error as NodeJS.ErrnoException;
        if (asNodeErr.code === 'ENOENT') {
          reject(new Error('git is required to resolve shared packs; install git and ensure it is on PATH'));
          return;
        }
        reject(error);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout });
          return;
        }
        reject(new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr.trim()}` : ''}`));
      });
    });
  };
}

export async function ensureSharedPack(
  spec: PackSpec,
  opts: { refresh?: boolean; gitRunner?: GitRunner; lockedSha?: string } = {},
): Promise<PackRuntime> {
  const runGit = opts.gitRunner ?? defaultGitRunner();
  validatePackSpec(spec);
  const gitUrl = repoToGitUrl(spec.repo);
  const key = `${spec.repo}@${spec.ref}`;
  const keyHash = Buffer.from(key).toString('base64url');
  const repoDir = path.join(cacheRoot(), 'packs', keyHash);
  await mkdir(path.dirname(repoDir), { recursive: true });

  if (opts.refresh) await rm(repoDir, { recursive: true, force: true });

  try {
    await stat(path.join(repoDir, '.git'));
  } catch {
    await runGit(['clone', gitUrl, repoDir]);
  }

  let resolvedSha: string;
  if (opts.lockedSha) {
    await runGit(['fetch', '--force', '--tags', 'origin', opts.lockedSha], repoDir);
    await runGit(['checkout', '--detach', opts.lockedSha], repoDir);
    resolvedSha = opts.lockedSha;
  } else {
    await runGit(['fetch', '--force', '--tags', 'origin', spec.ref], repoDir);
    await runGit(['checkout', '--detach', 'FETCH_HEAD'], repoDir);
    const result = await runGit(['rev-parse', 'HEAD'], repoDir);
    resolvedSha = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(resolvedSha)) {
      throw new Error(`unable to resolve pack '${spec.id}': git rev-parse HEAD returned ${JSON.stringify(resolvedSha)}`);
    }
  }

  const root = path.join(repoDir, '.rac');
  await loadSharedPackConfig(root);
  return { id: spec.id, root, sourceRepo: spec.repo, sourceRef: spec.ref, resolvedSha };
}

function mapId<T extends { id: string }>(items: T[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    item.id = normalizeDefinitionId(kind, item.id);
    if (seen.has(item.id)) throw new Error(`duplicate ${kind} id: ${item.id}`);
    seen.add(item.id);
  }
}

function isScalarJsonValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function assertTomlConfigValue(value: unknown, context: string): void {
  if (isScalarJsonValue(value)) return;
  if (value instanceof Date) throw new Error(`${context} rejects datetimes`);
  if (typeof value === 'number') throw new Error(`${context} rejects non-finite numbers`);
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    const firstType = typeof value[0];
    if (!isScalarJsonValue(value[0])) throw new Error(`${context} rejects arrays containing objects or arrays`);
    for (const entry of value) {
      if (!isScalarJsonValue(entry)) throw new Error(`${context} rejects arrays containing objects or arrays`);
      if (typeof entry !== firstType) throw new Error(`${context} rejects heterogeneous arrays`);
    }
    return;
  }
  const table = asRecord(value);
  if (table) {
    for (const [key, child] of Object.entries(table)) assertTomlConfigValue(child, `${context}.${key}`);
    return;
  }
  throw new Error(`${context} rejects unsupported value type: ${typeof value}`);
}

function assertJsonCompatible(value: unknown, context: string, allowNull: boolean): void {
  if (value === null) {
    if (allowNull) return;
    throw new Error(`${context} cannot be emitted as TOML null`);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new Error(`${context} rejects non-finite numbers`);
  }
  if (value instanceof Date) throw new Error(`${context} rejects datetimes`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertJsonCompatible(value[i], `${context}[${i}]`, allowNull);
    return;
  }
  const table = asRecord(value);
  if (table) {
    for (const [key, child] of Object.entries(table)) assertJsonCompatible(child, `${context}.${key}`, allowNull);
    return;
  }
  throw new Error(`${context} rejects unsupported value type: ${typeof value}`);
}

function mergeConfigValue(target: Record<string, unknown>, pathSegments: string[], value: unknown): void {
  let cursor = target;
  for (const segment of pathSegments.slice(0, -1)) {
    const next = cursor[segment];
    if (!asRecord(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[pathSegments[pathSegments.length - 1]] = value;
}

function flattenConfigLeaves(value: Record<string, unknown>, prefix: string[] = []): Array<{ path: string[]; value: unknown }> {
  const leaves: Array<{ path: string[]; value: unknown }> = [];
  for (const [key, child] of Object.entries(value)) {
    const pathSegments = [...prefix, key];
    const childTable = asRecord(child);
    if (childTable) leaves.push(...flattenConfigLeaves(childTable, pathSegments));
    else leaves.push({ path: pathSegments, value: child });
  }
  return leaves;
}

function assertNoSelectorOverlap(selectors: string[], context: string): void {
  const parsed = selectors.map((selector) => ({ selector, path: parseSelector(selector) }));
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      if (pathsOverlap(parsed[i].path, parsed[j].path)) throw new Error(`${context} selector overlap: ${parsed[i].selector} conflicts with ${parsed[j].selector}`);
    }
  }
}

function normalizeVendorTarget(rawTarget: string, configPath: string): Target {
  if (!VENDOR_CONFIG_TARGETS.includes(rawTarget as Target)) throw new Error(`unsupported vendor config target in ${configPath}: ${rawTarget}`);
  return rawTarget as Target;
}

export async function loadVendorConfigs(root: string, packId: string): Promise<VendorConfigDef[]> {
  const configPath = path.join(root, 'config.toml');
  const parsed = parseTomlOrThrow(configPath, await readFile(configPath, 'utf8'));
  const vendor = parsed.vendor;
  const vendorTable = asRecord(vendor);
  if (vendor !== undefined && !vendorTable) throw new Error(`invalid [vendor] block in ${configPath}`);
  if (!vendorTable) return [];

  const out: VendorConfigDef[] = [];
  for (const [rawTarget, rawTargetValue] of Object.entries(vendorTable)) {
    const target = normalizeVendorTarget(rawTarget, configPath);
    const targetTable = asRecord(rawTargetValue);
    if (!targetTable) throw new Error(`invalid [vendor.${rawTarget}] block in ${configPath}`);
    const values: Record<string, unknown> = {};
    const selectors: string[] = [];

    const config = targetTable.config;
    if (config !== undefined) {
      const configTable = asRecord(config);
      if (!configTable) throw new Error(`invalid [vendor.${target}.config] block in ${configPath}`);
      assertTomlConfigValue(configTable, `vendor.${target}.config`);
      for (const leaf of flattenConfigLeaves(configTable)) {
        mergeConfigValue(values, leaf.path, leaf.value);
        selectors.push(jsonPathBracketSelector(leaf.path));
      }
    }

    const raw = targetTable.raw;
    if (raw !== undefined) {
      const rawTable = asRecord(raw);
      if (!rawTable) throw new Error(`invalid [vendor.${target}.raw] block in ${configPath}`);
      for (const [key, value] of Object.entries(rawTable)) {
        assertJsonCompatible(value, `vendor.${target}.raw.${key}`, target !== 'codex');
        values[key] = value;
        selectors.push(jsonPathBracketSelector([key]));
      }
    }

    const rawJson = targetTable.raw_json;
    if (rawJson !== undefined) {
      const rawJsonTable = asRecord(rawJson);
      if (!rawJsonTable) throw new Error(`invalid [vendor.${target}.raw_json] block in ${configPath}`);
      for (const [key, jsonSource] of Object.entries(rawJsonTable)) {
        if (typeof jsonSource !== 'string') throw new Error(`vendor.${target}.raw_json.${key} must be a TOML string`);
        let value: unknown;
        try {
          value = JSON.parse(jsonSource) as unknown;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`invalid JSON in vendor.${target}.raw_json.${key}: ${reason}`);
        }
        assertJsonCompatible(value, `vendor.${target}.raw_json.${key}`, target !== 'codex');
        values[key] = value;
        selectors.push(jsonPathBracketSelector([key]));
      }
    }

    assertNoSelectorOverlap(selectors, `vendor.${target}`);
    if (selectors.length > 0) {
      out.push({ pack: packId, packRoot: root, target, values, selectors, sourcePath: configPath, sourceName: path.relative(root, configPath) });
    }
  }
  return out;
}

export async function loadInstallSettings(projectRoot: string): Promise<{ merge: boolean; targets?: Target[] }> {
  const configPath = path.join(projectRoot, 'config.toml');
  let raw: string;
  try { raw = await readFile(configPath, 'utf8'); }
  catch { return { merge: true }; }
  const parsed = parseTomlOrThrow(configPath, raw);
  const installRaw = parsed.install;
  if (installRaw === undefined) return { merge: true };
  if (!installRaw || typeof installRaw !== 'object' || Array.isArray(installRaw)) {
    throw new Error(`invalid [install] block in ${configPath}`);
  }
  const installTable = installRaw as Record<string, unknown>;
  const mergeRaw = installTable.merge;
  let merge = true;
  if (mergeRaw !== undefined) {
    if (typeof mergeRaw !== 'boolean') throw new Error(`invalid install.merge in ${configPath}; expected boolean`);
    merge = mergeRaw;
  }
  const targetsRaw = installTable.targets;
  if (targetsRaw === undefined) return { merge };
  if (!Array.isArray(targetsRaw)) throw new Error(`invalid install.targets in ${configPath}; expected array of strings`);
  const targets: Target[] = [];
  for (let i = 0; i < targetsRaw.length; i++) {
    const item = targetsRaw[i];
    if (!VENDOR_CONFIG_TARGETS.includes(item as Target)) {
      throw new Error(`invalid install.targets[${i}] in ${configPath}; expected claude|codex|opencode`);
    }
    targets.push(item as Target);
  }
  return { merge, targets };
}

export async function loadProjectPackConfig(projectRoot: string): Promise<{ packs: PackSpec[] }> {
  const configPath = path.join(projectRoot, 'config.toml');
  const parsed = parseTomlOrThrow(configPath, await readFile(configPath, 'utf8'));
  const rawPacks = parsed.packs;
  if (rawPacks === undefined) return { packs: [] };
  if (!Array.isArray(rawPacks)) throw new Error(`invalid [[packs]] block in ${configPath}`);

  const packs = rawPacks.map((raw): PackSpec => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid [[packs]] entry in ${configPath}`);
    const id = String((raw as Record<string, unknown>).id ?? '');
    const repo = String((raw as Record<string, unknown>).repo ?? '');
    const ref = (raw as Record<string, unknown>).ref;
    if (!id) throw new Error('missing packs.id');
    if (!repo) throw new Error(`missing packs.repo for ${id}`);
    if (ref === undefined || String(ref).trim() === '') throw new Error(`missing packs.ref for ${id}`);
    const spec = { id, repo, ref: String(ref) };
    validatePackSpec(spec);
    return spec;
  });
  mapId(packs, 'pack');
  return { packs };
}

export async function loadPackOverrides(projectRoot: string): Promise<PackOverride[]> {
  const configPath = path.join(projectRoot, 'config.local.toml');
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const parsed = parseTomlOrThrow(configPath, raw);

  for (const key of Object.keys(parsed)) {
    if (key !== 'pack_overrides') throw new Error(`unknown key "${key}" in ${configPath}; config.local.toml only supports [[pack_overrides]]`);
  }

  const rawOverrides = parsed.pack_overrides;
  if (rawOverrides === undefined) return [];
  if (!Array.isArray(rawOverrides)) throw new Error(`invalid [[pack_overrides]] block in ${configPath}`);

  const seen = new Set<string>();
  const out: PackOverride[] = [];

  for (let i = 0; i < rawOverrides.length; i++) {
    const entry = rawOverrides[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`invalid [[pack_overrides]] entry at index ${i} in ${configPath}`);
    }
    const row = entry as Record<string, unknown>;

    const id = row.id;
    if (id === undefined) throw new Error(`missing pack_overrides.id at index ${i} in ${configPath}`);
    if (typeof id !== 'string' || !id) throw new Error(`invalid pack_overrides.id at index ${i} in ${configPath}; must be a non-empty string`);
    if (!PACK_ID_RE.test(id)) throw new Error(`invalid pack id; use ASCII path-safe letters/numbers/./_/-: ${id}`);
    if (id === 'project') throw new Error(`invalid pack id; project is reserved for the local project pack`);
    if (seen.has(id)) throw new Error(`duplicate pack_overrides id: ${id}`);
    seen.add(id);

    const pathVal = row.path;
    if (pathVal === undefined) throw new Error(`missing pack_overrides.path for ${id} in ${configPath}`);
    if (typeof pathVal !== 'string' || !pathVal) throw new Error(`invalid pack_overrides.path for ${id} in ${configPath}; must be a non-empty string`);

    out.push({ id, path: pathVal });
  }

  return out;
}

export async function loadSharedPackConfig(root: string): Promise<void> {
  const configPath = path.join(root, 'config.toml');
  const parsed = parseTomlOrThrow(configPath, await readFile(configPath, 'utf8'));
  if (parsed.packs !== undefined) throw new Error(`shared pack config cannot contain [[packs]]: ${configPath}`);
}

export function resolvePackOverridePath(overridePath: string, projectRoot: string): string {
  const projectCwd = path.dirname(projectRoot);
  return path.isAbsolute(overridePath) ? overridePath : path.resolve(projectCwd, overridePath);
}

export async function ensureLocalPack(
  spec: PackSpec,
  overridePath: string,
  projectRoot: string,
): Promise<PackRuntime> {
  const resolved = resolvePackOverridePath(overridePath, projectRoot);

  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(resolved);
  } catch {
    throw new Error(`pack override path does not exist: ${spec.id} → ${resolved}`);
  }
  if (!dirStat.isDirectory()) throw new Error(`pack override path is not a directory: ${spec.id} → ${resolved}`);

  const innerConfig = path.join(resolved, '.rac', 'config.toml');
  try {
    await stat(innerConfig);
  } catch {
    throw new Error(`pack override path missing .rac/config.toml: ${spec.id} → ${resolved} (expected ${innerConfig})`);
  }

  await loadSharedPackConfig(path.join(resolved, '.rac'));

  return {
    id: spec.id,
    root: path.join(resolved, '.rac'),
    sourceRepo: spec.repo,
    sourceRef: spec.ref,
    override: { path: resolved },
  };
}

export class FrozenLockfileError extends Error {
  readonly frozenLockfile = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'FrozenLockfileError';
  }
}

function normalizeLockForCompare(lock: PackLockFile | null): string {
  if (lock === null) return JSON.stringify({ version: 1, packs: [] });
  const sorted = [...lock.packs].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ version: 1, packs: sorted });
}

export async function resolvePacks(
  cwd: string,
  opts: { refresh?: boolean; gitRunner?: GitRunner; frozen?: boolean; noWrite?: boolean } = {},
): Promise<PackRuntime[]> {
  const projectRoot = path.join(cwd, '.rac');
  const configPath = path.join(projectRoot, 'config.toml');
  try { await stat(configPath); } catch { throw new Error(`missing required config: ${configPath}`); }

  const project = await loadProjectPackConfig(projectRoot);
  const overrides = await loadPackOverrides(projectRoot);

  const overrideMap = new Map<string, PackOverride>();
  for (const ov of overrides) overrideMap.set(ov.id, ov);

  for (const ov of overrides) {
    const found = project.packs.some((p) => p.id === ov.id);
    if (!found) throw new Error(`pack override target not found: ${ov.id} (no matching [[packs]] entry in ${configPath})`);
  }

  const existingLock = await loadPackLock(projectRoot);

  const out: PackRuntime[] = [{ id: 'project', root: projectRoot }];
  const newLockEntries: PackLockEntry[] = [];

  for (const spec of project.packs) {
    const ov = overrideMap.get(spec.id);
    if (ov) {
      // Overridden packs are excluded from lockfile
      out.push(await ensureLocalPack(spec, ov.path, projectRoot));
    } else {
      let runtime: PackRuntime;
      if (opts.refresh === true) {
        // Resolving mode: always re-fetch
        runtime = await ensureSharedPack(spec, { refresh: true, gitRunner: opts.gitRunner });
      } else {
        const lockEntry = findLockEntry(existingLock, spec);
        if (lockEntry !== undefined) {
          // Locked mode: use the pinned SHA
          runtime = await ensureSharedPack(spec, { gitRunner: opts.gitRunner, lockedSha: lockEntry.resolved });
        } else {
          // Resolving mode: no lock entry yet
          runtime = await ensureSharedPack(spec, { gitRunner: opts.gitRunner });
        }
      }
      out.push(runtime);
      if (runtime.resolvedSha !== undefined) {
        newLockEntries.push({
          id: spec.id,
          repo: spec.repo,
          ref: spec.ref,
          resolved: runtime.resolvedSha,
        });
      }
    }
  }

  const newLock: PackLockFile = { version: 1, packs: newLockEntries };
  const lockChanged = normalizeLockForCompare(existingLock) !== normalizeLockForCompare(newLock);

  if (opts.frozen === true && lockChanged) {
    if (opts.noWrite === true) {
      // noWrite suppresses both the throw and the write — doctor handles reporting itself
    } else {
      // Build violation messages
      const violations: string[] = [];

      for (const entry of newLockEntries) {
        const existingEntry = existingLock?.packs.find(
          (e) => e.id === entry.id && e.repo === entry.repo && e.ref === entry.ref
        );
        if (existingEntry === undefined) {
          violations.push(
            `pack '${entry.id}' has no lockfile entry; run 'rac install' without --frozen-lockfile to create one`
          );
        } else if (existingEntry.resolved !== entry.resolved) {
          violations.push(
            `pack '${entry.id}' is locked to ${existingEntry.resolved} but config.toml ref '${entry.ref}' has moved upstream; run 'rac install --refresh-packs' to update`
          );
        }
      }

      // Also check if entries were removed from config (stale entries in lockfile)
      // Per spec: stale entries — do not throw for them in frozen mode, just don't write
      // (only violations from new/changed entries are reported)

      if (violations.length > 0) {
        throw new FrozenLockfileError(`--frozen-lockfile:\n${violations.join('\n')}`);
      }
      // If we get here, the only change is stale entries (removed packs) — don't write, don't throw
    }
  } else if (opts.frozen !== true && lockChanged && opts.noWrite !== true && newLockEntries.length > 0) {
    await writePackLock(projectRoot, newLock);
  } else if (opts.frozen !== true && lockChanged && opts.noWrite !== true && newLockEntries.length === 0 && existingLock !== null) {
    // All packs removed from config — write empty lockfile to clean up stale entries
    await writePackLock(projectRoot, newLock);
  }

  return out;
}

export async function loadAgents(root: string, packId: string): Promise<AgentDef[]> {
  const files = await fg('agents/*.toml', { cwd: root, absolute: true });
  const out = [] as AgentDef[];
  for (const file of files) {
    const parsed = agentSchema.parse(parseTomlOrThrow(file, await readFile(file, 'utf8')));
    out.push({
      pack: packId,
      packRoot: root,
      ...parsed,
      instructionsIsTemplate: parsed.instructions.endsWith('.tpl.md') || parsed.instructions.endsWith('.tpl.txt'),
      id: normalizeDefinitionId('agent', parsed.id),
      sourcePath: file,
      sourceName: path.relative(root, file)
    });
  }
  mapId(out, 'agent');
  return out;
}

export async function loadSkills(root: string, packId: string): Promise<SkillDef[]> {
  const files = await fg('skills/*/SKILL*.md', { cwd: root, absolute: true });
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = path.dirname(file);
    const existing = byDir.get(dir) ?? [];
    existing.push(file);
    byDir.set(dir, existing);
  }
  const out: SkillDef[] = [];
  for (const [dir, skillFiles] of byDir.entries()) {
    const hasSkillMd = skillFiles.some((file) => path.basename(file) === 'SKILL.md');
    const hasSkillTpl = skillFiles.some((file) => path.basename(file) === 'SKILL.tpl.md');
    if (hasSkillMd && hasSkillTpl) throw new Error(`skill dir cannot contain both SKILL.md and SKILL.tpl.md: ${dir}`);
    const file = skillFiles.find((entry) => {
      const base = path.basename(entry);
      return base === 'SKILL.md' || base === 'SKILL.tpl.md';
    });
    if (!file) continue;
    const id = normalizeDefinitionId('skill', path.basename(path.dirname(file)));
    const raw = await readFile(file, 'utf8');
    if (!raw.startsWith('+++')) throw new Error(`skill frontmatter must start with +++ at byte 0: ${file}`);
    const closingIndex = raw.indexOf('\n+++\n', 3);
    if (closingIndex < 0) throw new Error(`missing closing +++ delimiter: ${file}`);
    const frontmatter = skillSchema.parse(parseTomlOrThrow(file, raw.slice(4, closingIndex + 1)));
    const skillDir = path.dirname(file);
    const discovered = await fg('**/*', {
      cwd: skillDir,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      absolute: false
    });
    const assets = discovered
      .filter((rel) => {
        const base = path.posix.basename(rel);
        return base !== 'SKILL.md' && base !== 'SKILL.tpl.md';
      })
      .map((rel) => rel.split(path.sep).join('/'))
      .sort();
    for (const rel of assets) {
      const abs = path.resolve(skillDir, rel);
      if (!abs.startsWith(skillDir + path.sep)) {
        throw new Error(`skill asset escapes skill dir: ${path.relative(root, file)}: ${rel}`);
      }
    }
    out.push({
      pack: packId,
      packRoot: root,
      id,
      name: frontmatter.name,
      description: frontmatter.description,
      body: raw.slice(closingIndex + 5),
      bodyIsTemplate: path.basename(file) === 'SKILL.tpl.md',
      frontmatter,
      assets,
      sourcePath: file,
      sourceName: path.relative(root, file)
    });
  }
  mapId(out, 'skill');
  return out;
}

export async function loadMcps(root: string, packId: string): Promise<McpDef[]> {
  const files = await fg('mcps/*.toml', { cwd: root, absolute: true });
  const out = [] as McpDef[];
  for (const file of files) {
    const parsed = mcpSchema.parse(parseTomlOrThrow(file, await readFile(file, 'utf8')));
    out.push({ pack: packId, packRoot: root, ...parsed, id: normalizeDefinitionId('mcp', parsed.id), env: parsed.env, env_forward: parsed.env_forward, envVars: [...new Set([...collectEnvVarsFromText(JSON.stringify(parsed)), ...(parsed.env_forward ?? [])])].sort(), sourcePath: file, sourceName: path.relative(root, file) });
  }
  mapId(out, 'mcp');
  return out;
}

export async function loadRules(root: string, packId: string): Promise<RuleDef[]> {
  const files = await fg('rules/*.toml', { cwd: root, absolute: true });
  const ids = new Set<string>();
  const out: RuleDef[] = [];
  for (const file of files) {
    const parsedFile = parseTomlOrThrow(file, await readFile(file, 'utf8'));
    const rawRules = parsedFile.rule;
    if (!Array.isArray(rawRules) || rawRules.length === 0) throw new Error(`missing [[rule]] entries: ${file}`);
    for (const rawRule of rawRules) {
      const parsed = ruleSchema.parse(rawRule);
      if (!RULE_DECISIONS.has(parsed.decision)) throw new Error(`unsupported rule decision for ${parsed.id}: ${parsed.decision}`);
      if (!parsed.justification.trim()) throw new Error(`missing justification for rule ${parsed.id}`);
      if (parsed.command.length === 0) throw new Error(`empty command list for rule ${parsed.id}`);
      const normalized: RuleCommandItem[] = parsed.command.map((item) => {
        if (typeof item === 'string') {
          if (!item.trim()) throw new Error(`empty command segment for rule ${parsed.id}`);
          return item;
        }
        if (item.length === 0) throw new Error(`empty command alternative array for rule ${parsed.id}`);
        for (const entry of item) if (!entry.trim()) throw new Error(`empty command alternative for rule ${parsed.id}`);
        return item;
      });
      const id = normalizeDefinitionId('rule', parsed.id);
      if (ids.has(id)) throw new Error(`duplicate rule id: ${id}`);
      ids.add(id);
      out.push({ pack: packId, packRoot: root, id, decision: parsed.decision as RuleDecision, justification: parsed.justification, command: normalized, append_wildcard: parsed.append_wildcard ?? true, sourcePath: file, sourceName: path.relative(root, file) });
    }
  }
  return out;
}
