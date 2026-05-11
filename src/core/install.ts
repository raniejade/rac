import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { pickMergeStrategy } from '../adapters/merge-strategies.js';
import { adapterFor, vendorManifestRelPath } from '../adapters/target-adapters.js';

import { buildRuntimeConfig } from './config-model.js';
import type { ConfigWarning } from './config-model.js';
import { deleteManifest, loadManifest, saveManifest } from './manifest.js';
import { findLockEntry, loadPackLock } from './pack-lock.js';
import { loadAgents, loadInstallSettings, loadMcps, loadPackOverrides, loadProjectPackConfig, loadRules, loadSkills, loadVendorConfigs, resolvePackOverridePath, resolvePacks } from './parsers.js';
import type { GitRunner } from './parsers.js';
import type { InstallChange, InstallManifest, InstallOptions, InstallResult, Kind, ManifestRecord, PackLockFile, PackOverride, PackSpec, Scope, Target } from './types.js';
import { MANAGED_JSONC_WARNING, MANAGED_MARKDOWN_WARNING, MANAGED_TOML_WARNING, resolveContainedPath, sha256 } from './util.js';

export type PlannedWrite = ManifestRecord & {
  manifestRelPath: string;
  absPath: string;
  content?: string;
  sourceFile?: string;
  isJson?: boolean;
};

export type ManifestEntry = { root: string; manifestRelPath: string; absPath: string; manifest: InstallManifest };

export type ComputeInstallPlanResult = {
  plan: PlannedWrite[];
  targets: Target[];
  scope: Scope;
  noMerge: boolean;
  targetRootByTarget: Record<Target, string>;
  manifestsByAbsPath: Map<string, ManifestEntry>;
  ownedRelPaths: Set<string>;
  recordsByRelPath: Map<string, ManifestRecord[]>;
  planByRelPath: Map<string, PlannedWrite[]>;
  mergeOverrideHashByRelPath: Map<string, string>;
  liveKeysByManifestAbsPath: Map<string, Set<string>>;
  staleByManifestAbsPath: Map<string, { root: string; records: ManifestRecord[] }>;
  keptRelPaths: Set<string>;
  cleanRewriteSharedFiles: Array<{ absPath: string; content: string; hash: string; relPath: string }>;
  shouldMigrateLegacyOpenCodeJson: boolean;
  legacyOpenCodeSharedAbsPath: string | undefined;
  legacyOpenCodeSharedRecords: ManifestRecord[];
  nextManifestsByAbsPath: Map<string, { absPath: string; manifest: InstallManifest; manifestRelPath: string; root: string }>;
};

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function stableKey(record: Pick<ManifestRecord, 'pack' | 'target' | 'kind' | 'id' | 'relPath'>): string {
  return `${record.pack}:${record.target}:${record.kind}:${record.id}:${record.relPath}`;
}

function sortManifestRecords(records: ManifestRecord[]): ManifestRecord[] {
  return [...records].sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
}

function assertNoCrossPackDuplicate(items: Array<{ id: string; pack: string }>, kind: string): void {
  const owner = new Map<string, string>();
  for (const item of items) {
    const existing = owner.get(item.id);
    if (existing && existing !== item.pack) throw new Error(`duplicate ${kind} id across packs: ${item.id} (${existing}, ${item.pack})`);
    owner.set(item.id, item.pack);
  }
}

function startsWithManagedLine(content: string, warning: string): boolean {
  return content.startsWith(`${warning}\n`) || content.startsWith(`${warning}\r\n`);
}

function hasCanonicalManagedMarkdown(content: string): boolean {
  const escapedWarning = MANAGED_MARKDOWN_WARNING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n${escapedWarning}(?:\\r?\\n|$)`);
  return pattern.test(content);
}

async function canOverwrite(filePath: string, ownedRelPaths: Set<string>, relPath: string, force: boolean, strictJson: boolean, hasMergeStrategy: boolean): Promise<boolean> {
  if (!(await exists(filePath))) return true;
  if (force) return true;
  if (ownedRelPaths.has(relPath)) return true;
  if (hasMergeStrategy) return true;
  if (strictJson) return false;

  const existing = await readFile(filePath, 'utf8');
  if (startsWithManagedLine(existing, MANAGED_TOML_WARNING)) return true;
  if (startsWithManagedLine(existing, MANAGED_JSONC_WARNING)) return true;
  if (hasCanonicalManagedMarkdown(existing)) return true;
  return false;
}

export async function contentMatches(filePath: string, expectedHash: string): Promise<boolean> {
  return sha256(await readFile(filePath)) === expectedHash;
}

export const ALL_KINDS: Kind[] = ['agent', 'skill', 'mcp', 'rule', 'config'];
export const ALL_TARGETS: Target[] = ['claude', 'codex', 'opencode'];

export function isManagedOpenCodeSharedJson(record: Pick<ManifestRecord, 'target' | 'kind' | 'relPath'>): boolean {
  return record.target === 'opencode' && (record.kind === 'mcp' || record.kind === 'rule' || record.kind === 'config') && (record.relPath === '.opencode/opencode.jsonc' || record.relPath === '.opencode/opencode.json' || record.relPath === 'opencode/opencode.jsonc');
}

export function resolveScopeRoots(options: InstallOptions): { sourceRoot: string; targetRootHome: string; scope: Scope } {
  const scope: Scope = options.scope ?? 'project';
  if (scope === 'user') {
    const home = process.env.RAC_HOME?.trim() || os.homedir();
    return { sourceRoot: path.join(home, '.rac'), targetRootHome: home, scope };
  }
  return { sourceRoot: path.join(options.cwd, '.rac'), targetRootHome: options.cwd, scope };
}

export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
}

export function targetRootFor(target: Target, scope: Scope, home: string): string {
  if (scope === 'project') return home;
  if (target === 'opencode') return xdgConfigHome();
  return home;
}

export async function initProject(cwd: string, empty = false, scope: Scope = 'project'): Promise<void> {
  const root = scope === 'user'
    ? path.join(process.env.RAC_HOME?.trim() || os.homedir(), '.rac')
    : path.join(cwd, '.rac');
  for (const dirName of ['agents', 'skills', 'mcps', 'rules']) {
    await mkdir(path.join(root, dirName), { recursive: true });
  }
  const configPath = path.join(root, 'config.toml');
  if (!(await exists(configPath))) await writeFile(configPath, '', 'utf8');

  // Ensure .rac/.gitignore contains config.local.toml so local pack overrides
  // are never accidentally committed.
  const gitignorePath = path.join(root, '.gitignore');
  const GITIGNORE_ENTRY = 'config.local.toml';
  const existingGitignore = await exists(gitignorePath) ? await readFile(gitignorePath, 'utf8') : null;
  if (existingGitignore === null) {
    await writeFile(gitignorePath, `${GITIGNORE_ENTRY}\n`, 'utf8');
  } else {
    const lines = existingGitignore.split('\n');
    if (!lines.includes(GITIGNORE_ENTRY)) {
      const appended = existingGitignore.endsWith('\n')
        ? `${existingGitignore}${GITIGNORE_ENTRY}\n`
        : `${existingGitignore}\n${GITIGNORE_ENTRY}\n`;
      await writeFile(gitignorePath, appended, 'utf8');
    }
  }

  if (empty) return;

  const reviewerToml = path.join(root, 'agents', 'reviewer.toml');
  const reviewerInstructions = path.join(root, 'agents', 'reviewer.instructions.md');
  const projectGatesSkill = path.join(root, 'skills', 'project-gates', 'SKILL.md');
  const projectRulesMcp = path.join(root, 'mcps', 'project-rules.toml');
  const wrapperDenyRule = path.join(root, 'rules', 'wrapper-deny.toml');

  if (await exists(reviewerToml) || await exists(reviewerInstructions) || await exists(projectGatesSkill) || await exists(projectRulesMcp) || await exists(wrapperDenyRule)) {
    throw new Error('refusing to overwrite existing init examples');
  }

  await writeFile(
    reviewerInstructions,
    [
      '# Reviewer Agent',
      '',
      'Review planned changes against project rules and required gates.',
      'Block merges when required checks fail.',
      ''
    ].join('\n'),
    'utf8'
  );

  await writeFile(
    reviewerToml,
    [
      'id = "reviewer"',
      'name = "Reviewer"',
      'description = "Checks project rules and required gates"',
      'instructions = "./reviewer.instructions.md"',
      ''
    ].join('\n'),
    'utf8'
  );

  await mkdir(path.dirname(projectGatesSkill), { recursive: true });
  await writeFile(
    projectGatesSkill,
    [
      '+++',
      'name = "Project Gates"',
      'description = "Run required project gates before review"',
      '+++',
      '# Project Gates',
      '',
      'Run all required quality gates and summarize pass/fail with evidence.',
      ''
    ].join('\n'),
    'utf8'
  );
  await writeFile(path.join(path.dirname(projectGatesSkill), 'checklist.md'), '- build\n- test\n- lint\n', 'utf8');

  await writeFile(
    projectRulesMcp,
    [
      'id = "project-rules"',
      'command = "node"',
      'args = ["./tools/project-rules-mcp.js"]',
      'env_forward = ["PROJECT_RULES_TOKEN"]',
      '',
      '[env]',
      'LOG_LEVEL = "info"',
      ''
    ].join('\n'),
    'utf8'
  );

  await writeFile(
    wrapperDenyRule,
    [
      '[[rule]]',
      'id = "deny-git-push"',
      'decision = "forbidden"',
      'justification = "Use approved wrappers for push operations."',
      'command = ["git", "push"]',
      '',
      '[[rule]]',
      'id = "deny-gh-pr-merge"',
      'decision = "forbidden"',
      'justification = "Use approved wrappers for PR merges."',
      'command = ["gh", "pr", "merge"]',
      ''
    ].join('\n'),
    'utf8'
  );
}

export async function computeInstallPlan(options: InstallOptions): Promise<ComputeInstallPlanResult> {
  const { sourceRoot, targetRootHome, scope } = resolveScopeRoots(options);
  const installSettings = await loadInstallSettings(sourceRoot);
  const noMerge = options.noMerge ?? !installSettings.merge;
  const targets = options.targets ?? installSettings.targets ?? ALL_TARGETS;

  const targetRootByTarget: Record<Target, string> = {
    claude: targetRootFor('claude', scope, targetRootHome),
    codex: targetRootFor('codex', scope, targetRootHome),
    opencode: targetRootFor('opencode', scope, targetRootHome)
  };

  const manifestsByAbsPath = new Map<string, ManifestEntry>();
  for (const target of targets) {
    for (const kind of ALL_KINDS) {
      const manifestRelPath = vendorManifestRelPath(target, kind, scope);
      const root = targetRootByTarget[target];
      const absPath = resolveContainedPath(root, manifestRelPath, 'manifest path');
      if (manifestsByAbsPath.has(absPath)) continue;
      manifestsByAbsPath.set(absPath, { root, manifestRelPath, absPath, manifest: await loadManifest(root, manifestRelPath) });
    }
  }

  const ownedRelPaths = new Set<string>();
  for (const { manifest } of manifestsByAbsPath.values()) {
    for (const record of manifest.records) ownedRelPaths.add(record.relPath);
  }

  const cwdForPacks = scope === 'user'
    ? (process.env.RAC_HOME?.trim() || os.homedir())
    : options.cwd;
  const packs = await resolvePacks(cwdForPacks, { refresh: options.refreshPacks, frozen: options.frozen });
  const parsedAgents = [] as Awaited<ReturnType<typeof loadAgents>>;
  const parsedSkills = [] as Awaited<ReturnType<typeof loadSkills>>;
  const parsedMcps = [] as Awaited<ReturnType<typeof loadMcps>>;
  const parsedRules = [] as Awaited<ReturnType<typeof loadRules>>;
  const parsedConfigs = [] as Awaited<ReturnType<typeof loadVendorConfigs>>;
  for (const pack of packs) {
    if (options.kinds.includes('agent')) parsedAgents.push(...(await loadAgents(pack.root, pack.id)));
    if (options.kinds.includes('skill')) parsedSkills.push(...(await loadSkills(pack.root, pack.id)));
    if (options.kinds.includes('mcp')) parsedMcps.push(...(await loadMcps(pack.root, pack.id)));
    if (options.kinds.includes('rule')) parsedRules.push(...(await loadRules(pack.root, pack.id)));
    if (options.kinds.includes('config')) parsedConfigs.push(...(await loadVendorConfigs(pack.root, pack.id)));
  }
  assertNoCrossPackDuplicate(parsedAgents, 'agent');
  assertNoCrossPackDuplicate(parsedSkills, 'skill');
  assertNoCrossPackDuplicate(parsedMcps, 'mcp');
  assertNoCrossPackDuplicate(parsedRules, 'rule');
  const config = await buildRuntimeConfig({ root: sourceRoot, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps, rules: parsedRules, configs: parsedConfigs });

  const plan: PlannedWrite[] = [];
  for (const target of targets) {
    const adapter = adapterFor(target);
    const outputs = adapter.plan(config, scope);
    for (const output of outputs) {
      plan.push({
        version: 1,
        pack: output.pack,
        target: output.target,
        kind: output.kind,
        id: output.id,
        source: output.source,
        relPath: output.relPath,
        hash: output.hash,
        inventory: output.inventory,
        manifestRelPath: output.manifestRelPath,
        absPath: resolveContainedPath(targetRootByTarget[output.target], output.relPath, 'adapter output path'),
        content: output.content,
        sourceFile: output.sourceFile,
        isJson: output.isJson
      });
    }
  }

  const recordsByRelPath = new Map<string, ManifestRecord[]>();
  for (const { manifest } of manifestsByAbsPath.values()) {
    for (const record of manifest.records) {
      const existing = recordsByRelPath.get(record.relPath) ?? [];
      existing.push(record);
      recordsByRelPath.set(record.relPath, existing);
    }
  }
  const planByRelPath = new Map<string, PlannedWrite[]>();
  for (const write of plan) {
    const existing = planByRelPath.get(write.relPath) ?? [];
    existing.push(write);
    planByRelPath.set(write.relPath, existing);
  }
  for (const [relPath, writes] of planByRelPath.entries()) {
    const codexRuleWrites = writes.filter((write) => write.target === 'codex' && write.kind === 'rule');
    if (codexRuleWrites.length <= 1) continue;
    const sourceGroups = new Set<string>();
    for (const write of codexRuleWrites) sourceGroups.add(`${write.pack}:${write.source}`);
    if (sourceGroups.size <= 1) continue;
    throw new Error(`codex rule flat-path collision at ${relPath}; conflicting source groups: ${[...sourceGroups].sort((a, b) => a.localeCompare(b)).join(', ')}`);
  }
  for (const [relPath, writes] of planByRelPath.entries()) {
    if (writes.length <= 1) continue;
    const byHash = new Set(writes.map((write) => write.hash));
    if (byHash.size > 1) {
      const details = writes.map((write) => `${write.target}:${write.kind}:${write.pack}:${write.id}`).join(', ');
      throw new Error(`planned output collision at ${relPath}; generated contents differ across records: ${details}`);
    }
  }

  const selected = (record: ManifestRecord): boolean => targets.includes(record.target) && options.kinds.includes(record.kind);

  const legacyOpenCodeSharedRecords: ManifestRecord[] = [];
  let legacyOpenCodeSharedAbsPath: string | undefined;
  if (targets.includes('opencode') && scope === 'project') {
    const ocRoot = targetRootByTarget.opencode;
    legacyOpenCodeSharedAbsPath = resolveContainedPath(ocRoot, '.opencode/opencode.json', 'legacy shared opencode path');
    for (const record of recordsByRelPath.get('.opencode/opencode.json') ?? []) {
      if (isManagedOpenCodeSharedJson(record)) legacyOpenCodeSharedRecords.push(record);
    }
  }
  const shouldMigrateLegacyOpenCodeJson = scope === 'project'
    && targets.includes('opencode')
    && (options.kinds.includes('mcp') || options.kinds.includes('rule') || options.kinds.includes('config'))
    && legacyOpenCodeSharedRecords.length > 0
    && legacyOpenCodeSharedAbsPath !== undefined
    && (await exists(legacyOpenCodeSharedAbsPath));

  const mergeOverrideHashByRelPath = new Map<string, string>();

  if (!noMerge) {
    for (const [relPath, writes] of planByRelPath.entries()) {
      const target = writes[0].target;
      const strategy = pickMergeStrategy(target, relPath);
      if (!strategy) continue;
      const root = targetRootByTarget[target];
      const absPath = resolveContainedPath(root, relPath, 'merge target path');
      const legacyAbsPath = scope === 'project' && target === 'opencode' && relPath === '.opencode/opencode.jsonc'
        ? resolveContainedPath(root, '.opencode/opencode.json', 'legacy shared opencode path')
        : undefined;
      let existing: string | undefined;
      if (await exists(absPath)) existing = await readFile(absPath, 'utf8');
      else if (legacyAbsPath && (await exists(legacyAbsPath))) existing = await readFile(legacyAbsPath, 'utf8');
      const ownedHere = (recordsByRelPath.get(relPath) ?? []).filter((record) => record.target === target);
      const legacyOwned = (legacyAbsPath ? recordsByRelPath.get('.opencode/opencode.json') ?? [] : []).filter((record) => isManagedOpenCodeSharedJson(record));
      const ownedRecords = [...ownedHere, ...legacyOwned];
      const result = strategy.merge({
        existing,
        generated: writes[0].content ?? '',
        ownedRecords,
        nextRecords: writes,
        selectedKinds: new Set(options.kinds),
        phase: 'install'
      });
      for (const write of writes) {
        write.content = result.content;
        write.hash = result.hash;
      }
      mergeOverrideHashByRelPath.set(relPath, result.hash);
    }
  }

  const liveKeysByManifestAbsPath = new Map<string, Set<string>>();
  for (const write of plan) {
    const root = targetRootByTarget[write.target];
    const absPath = resolveContainedPath(root, write.manifestRelPath, 'manifest path');
    const records = liveKeysByManifestAbsPath.get(absPath) ?? new Set<string>();
    records.add(stableKey(write));
    liveKeysByManifestAbsPath.set(absPath, records);
  }

  const staleByManifestAbsPath = new Map<string, { root: string; records: ManifestRecord[] }>();
  const keptRelPaths = new Set<string>();
  for (const [absPath, entry] of manifestsByAbsPath) {
    const liveKeys = liveKeysByManifestAbsPath.get(absPath) ?? new Set<string>();
    for (const record of entry.manifest.records) {
      if (selected(record) && !liveKeys.has(stableKey(record))) {
        const stale = staleByManifestAbsPath.get(absPath) ?? { root: entry.root, records: [] };
        stale.records.push(record);
        staleByManifestAbsPath.set(absPath, stale);
      } else {
        keptRelPaths.add(record.relPath);
      }
    }
  }
  for (const write of plan) keptRelPaths.add(write.relPath);

  const cleanRewriteSharedFiles: Array<{ absPath: string; content: string; hash: string; relPath: string }> = [];
  if (options.clean && !noMerge) {
    const sharedRelPathsToClean: Array<{ target: Target; relPath: string }> = [];
    if (targets.includes('opencode') && (options.kinds.includes('mcp') || options.kinds.includes('rule') || options.kinds.includes('config'))) {
      sharedRelPathsToClean.push({ target: 'opencode', relPath: scope === 'user' ? 'opencode/opencode.jsonc' : '.opencode/opencode.jsonc' });
    }
    if (targets.includes('codex') && (options.kinds.includes('mcp') || options.kinds.includes('config'))) {
      sharedRelPathsToClean.push({ target: 'codex', relPath: '.codex/config.toml' });
    }
    if (targets.includes('claude') && options.kinds.includes('mcp')) {
      sharedRelPathsToClean.push({ target: 'claude', relPath: scope === 'user' ? '.claude.json' : '.mcp.json' });
    }
    if (targets.includes('claude') && options.kinds.includes('rule')) {
      sharedRelPathsToClean.push({ target: 'claude', relPath: '.claude/settings.json' });
    }
    if (targets.includes('claude') && options.kinds.includes('config')) {
      sharedRelPathsToClean.push({ target: 'claude', relPath: '.claude/settings.json' });
    }

    for (const { target, relPath } of sharedRelPathsToClean) {
      if (planByRelPath.has(relPath)) continue;
      const strategy = pickMergeStrategy(target, relPath);
      if (!strategy) continue;
      const root = targetRootByTarget[target];
      const absPath = resolveContainedPath(root, relPath, 'merge target path');
      const legacyAbsPath = scope === 'project' && target === 'opencode' && relPath === '.opencode/opencode.jsonc'
        ? resolveContainedPath(root, '.opencode/opencode.json', 'legacy shared opencode path')
        : undefined;
      let existing: string | undefined;
      if (await exists(absPath)) existing = await readFile(absPath, 'utf8');
      else if (legacyAbsPath && (await exists(legacyAbsPath))) existing = await readFile(legacyAbsPath, 'utf8');
      if (existing === undefined) continue;
      const ownedHere = (recordsByRelPath.get(relPath) ?? []).filter((record) => record.target === target);
      const legacyOwned = (legacyAbsPath ? recordsByRelPath.get('.opencode/opencode.json') ?? [] : []).filter((record) => isManagedOpenCodeSharedJson(record));
      const ownedRecords = [...ownedHere, ...legacyOwned];
      if (ownedRecords.length === 0) continue;
      const result = strategy.merge({
        existing,
        generated: '',
        ownedRecords,
        nextRecords: [],
        selectedKinds: new Set(options.kinds),
        phase: 'clean'
      });
      mergeOverrideHashByRelPath.set(relPath, result.hash);
      cleanRewriteSharedFiles.push({ absPath, content: result.content, hash: result.hash, relPath });
    }
  }

  const nextManifestsByAbsPath = new Map<string, { absPath: string; manifest: InstallManifest; manifestRelPath: string; root: string }>();
  const migrateLegacyOpenCodeSharedRecord = (record: ManifestRecord): ManifestRecord => {
    if (shouldMigrateLegacyOpenCodeJson && isManagedOpenCodeSharedJson(record) && record.relPath === '.opencode/opencode.json') {
      return { ...record, relPath: '.opencode/opencode.jsonc' };
    }
    return record;
  };
  const applyMergeOverride = (record: ManifestRecord): ManifestRecord => {
    const override = mergeOverrideHashByRelPath.get(record.relPath);
    if (override !== undefined) return { ...record, hash: override };
    return record;
  };
  for (const [absPath, entry] of manifestsByAbsPath) {
    const keep = entry.manifest.records.filter((record) => !selected(record)).map(migrateLegacyOpenCodeSharedRecord).map(applyMergeOverride);
    const planAbsPathFor = (record: PlannedWrite) => resolveContainedPath(targetRootByTarget[record.target], record.manifestRelPath, 'manifest path');
    const current = plan
      .filter((record) => planAbsPathFor(record) === absPath)
      .map(({ version, pack, target, kind, id, source, relPath, hash, inventory }) => applyMergeOverride(migrateLegacyOpenCodeSharedRecord({ version, pack, target, kind, id, source, relPath, hash, inventory })));
    nextManifestsByAbsPath.set(absPath, { absPath: entry.absPath, manifest: { version: 1, records: sortManifestRecords([...keep, ...current]) }, manifestRelPath: entry.manifestRelPath, root: entry.root });
  }

  return {
    plan,
    targets,
    scope,
    noMerge,
    targetRootByTarget,
    manifestsByAbsPath,
    ownedRelPaths,
    recordsByRelPath,
    planByRelPath,
    mergeOverrideHashByRelPath,
    liveKeysByManifestAbsPath,
    staleByManifestAbsPath,
    keptRelPaths,
    cleanRewriteSharedFiles,
    shouldMigrateLegacyOpenCodeJson,
    legacyOpenCodeSharedAbsPath,
    legacyOpenCodeSharedRecords,
    nextManifestsByAbsPath,
  };
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const r = await computeInstallPlan(options);
  const {
    plan,
    manifestsByAbsPath,
    ownedRelPaths,
    staleByManifestAbsPath,
    keptRelPaths,
    cleanRewriteSharedFiles,
    shouldMigrateLegacyOpenCodeJson,
    legacyOpenCodeSharedAbsPath,
    legacyOpenCodeSharedRecords,
    nextManifestsByAbsPath,
  } = r;

  const changes: InstallChange[] = [];
  const seenResultPath = new Set<string>();
  const checkedOverwritePath = new Set<string>();
  const appliedWriteByPath = new Set<string>();

  for (const write of plan) {
    if (!checkedOverwritePath.has(write.absPath)) {
      const strictJson = write.relPath === '.mcp.json' || write.relPath === '.claude/settings.json' || write.relPath.endsWith('.json') || write.relPath.endsWith('.rac-install-manifest.json');
      const hasStrategy = !r.noMerge && pickMergeStrategy(write.target, write.relPath) !== undefined;
      if (!(await canOverwrite(write.absPath, ownedRelPaths, write.relPath, !!options.force, strictJson, hasStrategy))) {
        throw new Error(`refusing overwrite unmanaged file: ${write.absPath}`);
      }
      checkedOverwritePath.add(write.absPath);
    }

    const alreadyExists = await exists(write.absPath);
    if (!seenResultPath.has(write.absPath)) {
      if (!alreadyExists) {
        changes.push({
          action: 'create',
          target: write.target,
          kind: write.kind,
          pack: write.pack,
          id: write.id,
          relPath: write.relPath,
          absPath: write.absPath
        });
      } else if (!(await contentMatches(write.absPath, write.hash))) {
        changes.push({
          action: 'update',
          target: write.target,
          kind: write.kind,
          pack: write.pack,
          id: write.id,
          relPath: write.relPath,
          absPath: write.absPath
        });
      }
      seenResultPath.add(write.absPath);
    }

    if (!options.dryRun && !options.check && !appliedWriteByPath.has(write.absPath)) {
      await mkdir(path.dirname(write.absPath), { recursive: true });
      if (write.sourceFile) {
        await copyFile(write.sourceFile, write.absPath);
      } else {
        await writeFile(write.absPath, write.content ?? '', 'utf8');
      }
      appliedWriteByPath.add(write.absPath);
    }
  }

  const seenDeletePath = new Set<string>();
  if (options.clean) {
    for (const { root, records: staleRecords } of staleByManifestAbsPath.values()) {
      for (const staleRecord of staleRecords) {
        if (keptRelPaths.has(staleRecord.relPath)) continue;
        const absPath = resolveContainedPath(root, staleRecord.relPath, 'stale manifest record path');
        if (options.dryRun || options.check || seenDeletePath.has(absPath)) continue;
        if (await exists(absPath)) {
          await rm(absPath, { recursive: true, force: true });
          changes.push({ action: 'delete', target: staleRecord.target, kind: staleRecord.kind, pack: staleRecord.pack, id: staleRecord.id, relPath: staleRecord.relPath, absPath });
          seenDeletePath.add(absPath);
        }
      }
    }
  }

  if (shouldMigrateLegacyOpenCodeJson && legacyOpenCodeSharedAbsPath) {
    if (!options.dryRun && !options.check) {
      await rm(legacyOpenCodeSharedAbsPath, { force: true });
    }
    const legacyRecord = legacyOpenCodeSharedRecords[0];
    changes.push({
      action: 'delete',
      target: legacyRecord.target,
      kind: legacyRecord.kind,
      pack: legacyRecord.pack,
      id: legacyRecord.id,
      relPath: '.opencode/opencode.json',
      absPath: legacyOpenCodeSharedAbsPath
    });
  }

  if (options.check) {
    const failures: string[] = [];
    for (const write of plan) {
      if (!(await exists(write.absPath))) {
        failures.push(`missing generated output: ${write.absPath}`);
        continue;
      }
      if (!(await contentMatches(write.absPath, write.hash))) {
        failures.push(`different generated output: ${write.absPath}`);
      }
    }

    for (const [absPath, next] of nextManifestsByAbsPath) {
      const current = manifestsByAbsPath.get(absPath)?.manifest ?? { version: 1, records: [] };
      if (JSON.stringify(current) !== JSON.stringify(next.manifest)) {
        failures.push(`manifest would change: ${next.absPath}`);
      }
    }

    for (const sharedRewrite of cleanRewriteSharedFiles) {
      if (!(await exists(sharedRewrite.absPath))) {
        failures.push(`missing generated output: ${sharedRewrite.absPath}`);
      } else if (!(await contentMatches(sharedRewrite.absPath, sharedRewrite.hash))) {
        failures.push(`different generated output: ${sharedRewrite.absPath}`);
      }
    }

    for (const { root, records: staleRecords } of staleByManifestAbsPath.values()) {
      for (const staleRecord of staleRecords) {
        failures.push(`stale managed output requires cleanup: ${resolveContainedPath(root, staleRecord.relPath, 'stale manifest record path')}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(['install --check failed:', ...failures].join('\n'));
    }
    return { changes, create: changes.filter(c => c.action === 'create').map(c => c.absPath), update: changes.filter(c => c.action === 'update').map(c => c.absPath), del: changes.filter(c => c.action === 'delete').map(c => c.absPath) };
  }

  if (!options.dryRun) {
    for (const sharedRewrite of cleanRewriteSharedFiles) {
      await mkdir(path.dirname(sharedRewrite.absPath), { recursive: true });
      await writeFile(sharedRewrite.absPath, sharedRewrite.content, 'utf8');
    }
    for (const { manifestRelPath, manifest, root } of nextManifestsByAbsPath.values()) {
      if (manifest.records.length === 0) {
        await deleteManifest(root, manifestRelPath);
      } else {
        await saveManifest(root, manifestRelPath, manifest);
      }
    }
  }

  return {
    changes,
    create: changes.filter(c => c.action === 'create').map(c => c.absPath),
    update: changes.filter(c => c.action === 'update').map(c => c.absPath),
    del: changes.filter(c => c.action === 'delete').map(c => c.absPath)
  };
}

export function buildOverrideWarnings(overrides: PackOverride[], projectRoot: string): ConfigWarning[] {
  return overrides.map((ov) => {
    const resolved = resolvePackOverridePath(ov.path, projectRoot);
    return {
      severity: 'warn' as const,
      code: 'pack_override_active',
      message: `pack override active: ${ov.id} → ${resolved}`,
      hint: `remove via \`rac pack override --clear ${ov.id}\` before publishing`,
      context: { pack: ov.id },
    };
  });
}

export async function doctor(
  cwd: string,
  targets: Target[] | undefined,
  kinds: Kind[],
  scope: Scope = 'project',
  opts: { frozen?: boolean; gitRunner?: GitRunner } = {},
): Promise<ConfigWarning[]> {
  const sourceCwd = scope === 'user' ? (process.env.RAC_HOME?.trim() || os.homedir()) : cwd;
  const root = path.join(sourceCwd, '.rac');
  const installSettings = await loadInstallSettings(root);
  const resolvedTargets = targets ?? installSettings.targets ?? ALL_TARGETS;

  const warnings: ConfigWarning[] = [];

  // Lockfile diagnostics (project scope only — must run before resolvePacks so
  // a malformed lockfile is caught here rather than thrown by resolvePacks)
  let lockMalformedError: Error | null = null;
  if (scope === 'project') {
    let existingLock: PackLockFile | null = null;
    try {
      existingLock = await loadPackLock(root);
    } catch (err) {
      lockMalformedError = err instanceof Error ? err : new Error(String(err));
    }

    if (lockMalformedError !== null) {
      // Diagnostic 1: malformed lockfile
      warnings.push({
        severity: 'error',
        code: 'lockfile_malformed',
        message: lockMalformedError.message,
        hint: "delete .rac/rac-lock.json and run 'rac install' to regenerate",
        context: {},
      });
    } else {
      // Load project pack config and overrides for lockfile checks
      const project = await loadProjectPackConfig(root);
      const projectOverrides = await loadPackOverrides(root);
      const overrideMap = new Map<string, true>();
      for (const ov of projectOverrides) overrideMap.set(ov.id, true);

      // Diagnostic 2: missing lockfile entry (frozen mode only)
      if (opts.frozen === true) {
        for (const spec of project.packs as PackSpec[]) {
          if (overrideMap.has(spec.id)) continue; // overrides are excluded from lockfile
          if (findLockEntry(existingLock, spec) === undefined) {
            warnings.push({
              severity: 'error',
              code: 'missing_lockfile_entry',
              message: `pack '${spec.id}' has no lockfile entry; run 'rac install' without --frozen-lockfile to create one`,
              context: { pack: spec.id },
            });
          }
        }
      }

      // Diagnostic 3: stale lockfile entry (always when lock is loadable and non-null)
      if (existingLock !== null) {
        for (const entry of existingLock.packs) {
          const stillReferenced = (project.packs as PackSpec[]).some(
            (spec) => spec.id === entry.id && spec.repo === entry.repo && spec.ref === entry.ref,
          );
          if (!stillReferenced) {
            warnings.push({
              severity: 'warn',
              code: 'stale_lockfile_entry',
              message: `stale lockfile entry: '${entry.id}' is no longer referenced by config.toml; it will be removed on the next 'rac install'`,
              hint: undefined,
              context: { pack: entry.id },
            });
          }
        }
      }
    }
  }

  // Do NOT pass frozen into resolvePacks — doctor reports frozen-mode issues itself.
  // When the lockfile is malformed, resolvePacks would also fail; skip it to avoid
  // masking the diagnostic with an exception.
  let packs: Awaited<ReturnType<typeof resolvePacks>> = [];
  if (lockMalformedError === null) {
    packs = await resolvePacks(sourceCwd, { gitRunner: opts.gitRunner, noWrite: true });
  }

  const parsedAgents = [] as Awaited<ReturnType<typeof loadAgents>>;
  const parsedSkills = [] as Awaited<ReturnType<typeof loadSkills>>;
  const parsedMcps = [] as Awaited<ReturnType<typeof loadMcps>>;
  const parsedRules = [] as Awaited<ReturnType<typeof loadRules>>;
  const parsedConfigs = [] as Awaited<ReturnType<typeof loadVendorConfigs>>;
  for (const pack of packs) {
    if (kinds.includes('agent')) parsedAgents.push(...(await loadAgents(pack.root, pack.id)));
    if (kinds.includes('skill')) parsedSkills.push(...(await loadSkills(pack.root, pack.id)));
    if (kinds.includes('mcp')) parsedMcps.push(...(await loadMcps(pack.root, pack.id)));
    if (kinds.includes('rule')) parsedRules.push(...(await loadRules(pack.root, pack.id)));
    if (kinds.includes('config')) parsedConfigs.push(...(await loadVendorConfigs(pack.root, pack.id)));
  }
  assertNoCrossPackDuplicate(parsedAgents, 'agent');
  assertNoCrossPackDuplicate(parsedSkills, 'skill');
  assertNoCrossPackDuplicate(parsedMcps, 'mcp');
  assertNoCrossPackDuplicate(parsedRules, 'rule');
  const config = await buildRuntimeConfig({ root, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps, rules: parsedRules, configs: parsedConfigs });

  // Emit WARN per active pack override (project scope only; user scope doesn't support packs)
  if (scope === 'project') {
    const overrides = await loadPackOverrides(root);
    warnings.push(...buildOverrideWarnings(overrides, root));
  }

  if (kinds.includes('mcp')) {
    for (const mcp of config.mcps) {
      for (const envRef of mcp.envRefs) {
        if (!process.env[envRef]) warnings.push({
          severity: 'error',
          code: 'missing_env_var',
          message: `missing env var: ${envRef} (referenced by mcp ${mcp.id})`,
          hint: 'set the env var or remove the reference',
          context: { kind: 'mcp', id: mcp.id }
        });
      }
    }
  }

  if (kinds.includes('agent')) {
    if (resolvedTargets.includes('opencode')) {
      warnings.push(...config.warnings.filter((w) => w.code === 'opencode_legacy_tools'));
    }
  }

  return warnings;
}
