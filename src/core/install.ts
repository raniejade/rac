import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import { adapterFor, vendorManifestRelPath } from '../adapters/target-adapters.js';

import { buildRuntimeConfig } from './config-model.js';
import { deleteManifest, loadManifest, saveManifest } from './manifest.js';
import { loadAgents, loadMcps, loadRules, loadSkills, resolvePacks } from './parsers.js';
import type { InstallManifest, InstallOptions, InstallResult, Kind, ManifestRecord, Target } from './types.js';
import { MANAGED_JSONC_WARNING, MANAGED_MARKDOWN_WARNING, MANAGED_TOML_WARNING, resolveContainedPath, sha256 } from './util.js';

type PlannedWrite = ManifestRecord & {
  manifestRelPath: string;
  absPath: string;
  content?: string;
  sourceFile?: string;
  isJson?: boolean;
};

async function exists(filePath: string): Promise<boolean> {
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

async function canOverwrite(filePath: string, ownedRelPaths: Set<string>, relPath: string, force: boolean, strictJson: boolean): Promise<boolean> {
  if (!(await exists(filePath))) return true;
  if (force) return true;
  if (ownedRelPaths.has(relPath)) return true;
  if (strictJson) return false;

  const existing = await readFile(filePath, 'utf8');
  if (startsWithManagedLine(existing, MANAGED_TOML_WARNING)) return true;
  if (startsWithManagedLine(existing, MANAGED_JSONC_WARNING)) return true;
  if (hasCanonicalManagedMarkdown(existing)) return true;
  return false;
}

async function contentMatches(filePath: string, expectedHash: string): Promise<boolean> {
  return sha256(await readFile(filePath)) === expectedHash;
}

function selectedManifestRelPaths(targets: Target[], kinds: Kind[]): Set<string> {
  const selected = new Set<string>();
  for (const target of targets) {
    for (const kind of kinds) {
      selected.add(vendorManifestRelPath(target, kind));
    }
  }
  return selected;
}

const ALL_KINDS: Kind[] = ['agent', 'skill', 'mcp', 'rule'];

function isManagedOpenCodeSharedJson(record: Pick<ManifestRecord, 'target' | 'kind' | 'relPath'>): boolean {
  return record.target === 'opencode' && (record.kind === 'mcp' || record.kind === 'rule') && (record.relPath === '.opencode/opencode.jsonc' || record.relPath === '.opencode/opencode.json');
}

function stableOpenCodeConfigJson(config: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(config, 'mcp')) ordered.mcp = config.mcp;
  if (Object.prototype.hasOwnProperty.call(config, 'permission')) ordered.permission = config.permission;
  for (const [key, value] of Object.entries(config).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'mcp' || key === 'permission') continue;
    ordered[key] = value;
  }
  return `${MANAGED_JSONC_WARNING}\n${JSON.stringify(ordered, null, 2)}\n`;
}

function parseOpenCodeConfig(raw: string): Record<string, unknown> {
  return parseJsonc(raw) as Record<string, unknown>;
}

export async function initProject(cwd: string, empty = false): Promise<void> {
  const root = path.join(cwd, '.rac');
  for (const dirName of ['agents', 'skills', 'mcps', 'rules']) {
    await mkdir(path.join(root, dirName), { recursive: true });
  }
  const configPath = path.join(root, 'config.toml');
  if (!(await exists(configPath))) await writeFile(configPath, '', 'utf8');
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
      'assets = ["checklist.md"]',
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
      'args = ["./tools/project-rules-mcp.js", "${PROJECT_RULES_TOKEN}"]',
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

export async function install(options: InstallOptions): Promise<InstallResult> {
  const root = path.join(options.cwd, '.rac');
  const targetRoot = options.cwd;

  const manifestsByRelPath = new Map<string, InstallManifest>();
  for (const relPath of selectedManifestRelPaths(options.targets, ALL_KINDS)) {
    manifestsByRelPath.set(relPath, await loadManifest(targetRoot, relPath));
  }

  const ownedRelPaths = new Set<string>();
  for (const manifest of manifestsByRelPath.values()) {
    for (const record of manifest.records) ownedRelPaths.add(record.relPath);
  }

  const packs = await resolvePacks(options.cwd);
  const parsedAgents = [] as Awaited<ReturnType<typeof loadAgents>>;
  const parsedSkills = [] as Awaited<ReturnType<typeof loadSkills>>;
  const parsedMcps = [] as Awaited<ReturnType<typeof loadMcps>>;
  const parsedRules = [] as Awaited<ReturnType<typeof loadRules>>;
  for (const pack of packs) {
    if (options.kinds.includes('agent')) parsedAgents.push(...(await loadAgents(pack.root, pack.id)));
    if (options.kinds.includes('skill')) parsedSkills.push(...(await loadSkills(pack.root, pack.id)));
    if (options.kinds.includes('mcp')) parsedMcps.push(...(await loadMcps(pack.root, pack.id)));
    if (options.kinds.includes('rule')) parsedRules.push(...(await loadRules(pack.root, pack.id)));
  }
  assertNoCrossPackDuplicate(parsedAgents, 'agent');
  assertNoCrossPackDuplicate(parsedSkills, 'skill');
  assertNoCrossPackDuplicate(parsedMcps, 'mcp');
  assertNoCrossPackDuplicate(parsedRules, 'rule');
  const config = await buildRuntimeConfig({ root, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps, rules: parsedRules });

  const plan: PlannedWrite[] = [];
  for (const target of options.targets) {
    const adapter = adapterFor(target);
    const outputs = adapter.plan(config);
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
        absPath: resolveContainedPath(targetRoot, output.relPath, 'adapter output path'),
        content: output.content,
        sourceFile: output.sourceFile,
        isJson: output.isJson
      });
    }
  }

  const recordsByRelPath = new Map<string, ManifestRecord[]>();
  for (const manifest of manifestsByRelPath.values()) {
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
    if (writes.length <= 1) continue;
    const byHash = new Set(writes.map((write) => write.hash));
    if (byHash.size > 1) {
      const details = writes.map((write) => `${write.target}:${write.kind}:${write.pack}:${write.id}`).join(', ');
      throw new Error(`planned output collision at ${relPath}; generated contents differ across records: ${details}`);
    }
  }

  const opencodeSharedWrites = planByRelPath.get('.opencode/opencode.jsonc') ?? [];
  const legacyOpenCodeSharedRecords = (recordsByRelPath.get('.opencode/opencode.json') ?? []).filter(isManagedOpenCodeSharedJson);
  const legacyOpenCodeSharedPath = resolveContainedPath(targetRoot, '.opencode/opencode.json', 'legacy shared opencode path');
  const shouldMigrateLegacyOpenCodeJson = options.targets.includes('opencode')
    && (options.kinds.includes('mcp') || options.kinds.includes('rule'))
    && legacyOpenCodeSharedRecords.length > 0
    && (await exists(legacyOpenCodeSharedPath));
  let openCodeSharedManagedHashOverride: string | undefined;
  if (opencodeSharedWrites.length > 0) {
    const siblingKinds = new Set<Kind>();
    for (const record of [...(recordsByRelPath.get('.opencode/opencode.jsonc') ?? []), ...(recordsByRelPath.get('.opencode/opencode.json') ?? [])]) {
      if (!isManagedOpenCodeSharedJson(record)) continue;
      if (options.targets.includes(record.target) && !options.kinds.includes(record.kind)) siblingKinds.add(record.kind);
    }
    const opencodeSharedPath = resolveContainedPath(targetRoot, '.opencode/opencode.jsonc', 'shared opencode path');
    const existingSharedPath = (await exists(opencodeSharedPath)) ? opencodeSharedPath : ((await exists(legacyOpenCodeSharedPath)) ? legacyOpenCodeSharedPath : undefined);
    if (siblingKinds.size > 0 && existingSharedPath) {
      const existingRaw = await readFile(existingSharedPath, 'utf8');
      const existingParsed = parseOpenCodeConfig(existingRaw);
      const generatedParsed = parseOpenCodeConfig(opencodeSharedWrites[0].content ?? '{}');
      if (siblingKinds.has('mcp') && !Object.prototype.hasOwnProperty.call(generatedParsed, 'mcp') && Object.prototype.hasOwnProperty.call(existingParsed, 'mcp')) {
        generatedParsed.mcp = existingParsed.mcp;
      }
      if (siblingKinds.has('rule') && !Object.prototype.hasOwnProperty.call(generatedParsed, 'permission') && Object.prototype.hasOwnProperty.call(existingParsed, 'permission')) {
        generatedParsed.permission = existingParsed.permission;
      }
      const mergedContent = stableOpenCodeConfigJson(generatedParsed);
      const mergedHash = sha256(mergedContent);
      openCodeSharedManagedHashOverride = mergedHash;
      for (const write of opencodeSharedWrites) {
        write.content = mergedContent;
        write.hash = mergedHash;
      }
    } else {
      openCodeSharedManagedHashOverride = opencodeSharedWrites[0].hash;
    }
  }

  const create: string[] = [];
  const update: string[] = [];
  const seenResultPath = new Set<string>();
  const checkedOverwritePath = new Set<string>();
  const appliedWriteByPath = new Set<string>();

  for (const write of plan) {
    if (!checkedOverwritePath.has(write.absPath)) {
      const strictJson = write.relPath === '.mcp.json' || write.relPath === '.claude/settings.json' || write.relPath.endsWith('.json') || write.relPath.endsWith('.rac-install-manifest.json');
      if (!(await canOverwrite(write.absPath, ownedRelPaths, write.relPath, !!options.force, strictJson))) {
        throw new Error(`refusing overwrite unmanaged file: ${write.absPath}`);
      }
      checkedOverwritePath.add(write.absPath);
    }

    const alreadyExists = await exists(write.absPath);
    if (!seenResultPath.has(write.absPath)) {
      if (!alreadyExists) {
        create.push(write.absPath);
      } else if (!(await contentMatches(write.absPath, write.hash))) {
        update.push(write.absPath);
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

  const selected = (record: ManifestRecord): boolean => options.targets.includes(record.target) && options.kinds.includes(record.kind);
  const liveKeysByManifestRelPath = new Map<string, Set<string>>();
  for (const write of plan) {
    const records = liveKeysByManifestRelPath.get(write.manifestRelPath) ?? new Set<string>();
    records.add(stableKey(write));
    liveKeysByManifestRelPath.set(write.manifestRelPath, records);
  }

  const staleByManifestRelPath = new Map<string, ManifestRecord[]>();
  const keptRelPaths = new Set<string>();
  for (const [manifestRelPath, manifest] of manifestsByRelPath) {
    const liveKeys = liveKeysByManifestRelPath.get(manifestRelPath) ?? new Set<string>();
    for (const record of manifest.records) {
      if (selected(record) && !liveKeys.has(stableKey(record))) {
        const stale = staleByManifestRelPath.get(manifestRelPath) ?? [];
        stale.push(record);
        staleByManifestRelPath.set(manifestRelPath, stale);
      } else {
        keptRelPaths.add(record.relPath);
      }
    }
  }
  for (const write of plan) keptRelPaths.add(write.relPath);

  let cleanRewriteOpenCodeShared: { absPath: string; content: string; hash: string } | undefined;
  if (options.clean && options.targets.includes('opencode') && (options.kinds.includes('mcp') || options.kinds.includes('rule'))) {
    const sharedRelPath = '.opencode/opencode.jsonc';
    const absPath = resolveContainedPath(targetRoot, sharedRelPath, 'shared opencode path');
    const sharedManifestRecords = ([...(recordsByRelPath.get(sharedRelPath) ?? []), ...(recordsByRelPath.get('.opencode/opencode.json') ?? [])]).filter(isManagedOpenCodeSharedJson);
    const hasUnselectedSibling = sharedManifestRecords.some((record) => !selected(record));
    const existingSharedPath = (await exists(absPath)) ? absPath : ((await exists(legacyOpenCodeSharedPath)) ? legacyOpenCodeSharedPath : undefined);
    if (hasUnselectedSibling && existingSharedPath) {
      const existingRaw = await readFile(existingSharedPath, 'utf8');
      const existingParsed = parseOpenCodeConfig(existingRaw);
      const generatedWrites = planByRelPath.get(sharedRelPath) ?? [];
      const generatedParsed = generatedWrites.length > 0
        ? parseOpenCodeConfig(generatedWrites[0].content ?? '{}')
        : {};

      if (!Object.prototype.hasOwnProperty.call(generatedParsed, 'mcp') && sharedManifestRecords.some((record) => !selected(record) && record.kind === 'mcp') && Object.prototype.hasOwnProperty.call(existingParsed, 'mcp')) {
        generatedParsed.mcp = existingParsed.mcp;
      }
      if (!Object.prototype.hasOwnProperty.call(generatedParsed, 'permission') && sharedManifestRecords.some((record) => !selected(record) && record.kind === 'rule') && Object.prototype.hasOwnProperty.call(existingParsed, 'permission')) {
        generatedParsed.permission = existingParsed.permission;
      }

      if (options.kinds.includes('mcp') && !generatedWrites.some((write) => write.kind === 'mcp')) delete generatedParsed.mcp;
      if (options.kinds.includes('rule') && !generatedWrites.some((write) => write.kind === 'rule')) delete generatedParsed.permission;

      const content = stableOpenCodeConfigJson(generatedParsed);
      const hash = sha256(content);
      openCodeSharedManagedHashOverride = hash;
      cleanRewriteOpenCodeShared = { absPath, content, hash };
    }
  }

  const del: string[] = [];
  const seenDeletePath = new Set<string>();
  if (options.clean) {
    for (const staleRecords of staleByManifestRelPath.values()) {
      for (const staleRecord of staleRecords) {
        if (keptRelPaths.has(staleRecord.relPath)) continue;
        const absPath = resolveContainedPath(targetRoot, staleRecord.relPath, 'stale manifest record path');
        if (options.dryRun || options.check || seenDeletePath.has(absPath)) continue;
        if (await exists(absPath)) {
          await rm(absPath, { recursive: true, force: true });
          del.push(absPath);
          seenDeletePath.add(absPath);
        }
      }
    }
  }

  if (!options.dryRun && !options.check && shouldMigrateLegacyOpenCodeJson) {
    await rm(legacyOpenCodeSharedPath, { force: true });
    del.push(legacyOpenCodeSharedPath);
  }

  const nextManifestsByRelPath = new Map<string, InstallManifest>();
  const migrateLegacyOpenCodeSharedRecord = (record: ManifestRecord): ManifestRecord => {
    if (shouldMigrateLegacyOpenCodeJson && isManagedOpenCodeSharedJson(record) && record.relPath === '.opencode/opencode.json') {
      return { ...record, relPath: '.opencode/opencode.jsonc' };
    }
    return record;
  };
  const applySharedHashOverride = (record: ManifestRecord): ManifestRecord => {
    if (openCodeSharedManagedHashOverride && isManagedOpenCodeSharedJson(record)) return { ...record, hash: openCodeSharedManagedHashOverride };
    return record;
  };
  for (const [manifestRelPath, manifest] of manifestsByRelPath) {
    const keep = manifest.records.filter((record) => !selected(record)).map(migrateLegacyOpenCodeSharedRecord).map(applySharedHashOverride);
    const current = plan
      .filter((record) => record.manifestRelPath === manifestRelPath)
      .map(({ version, pack, target, kind, id, source, relPath, hash, inventory }) => applySharedHashOverride(migrateLegacyOpenCodeSharedRecord({ version, pack, target, kind, id, source, relPath, hash, inventory })));
    nextManifestsByRelPath.set(manifestRelPath, { version: 1, records: sortManifestRecords([...keep, ...current]) });
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

    for (const [manifestRelPath, next] of nextManifestsByRelPath) {
      const current = manifestsByRelPath.get(manifestRelPath) ?? { version: 1, records: [] };
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        failures.push(`manifest would change: ${resolveContainedPath(targetRoot, manifestRelPath, 'manifest path')}`);
      }
    }

    if (cleanRewriteOpenCodeShared) {
      if (!(await exists(cleanRewriteOpenCodeShared.absPath))) {
        failures.push(`missing generated output: ${cleanRewriteOpenCodeShared.absPath}`);
      } else if (!(await contentMatches(cleanRewriteOpenCodeShared.absPath, cleanRewriteOpenCodeShared.hash))) {
        failures.push(`different generated output: ${cleanRewriteOpenCodeShared.absPath}`);
      }
    }

    for (const staleRecords of staleByManifestRelPath.values()) {
      for (const staleRecord of staleRecords) {
        failures.push(`stale managed output requires cleanup: ${resolveContainedPath(targetRoot, staleRecord.relPath, 'stale manifest record path')}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(['install --check failed:', ...failures].join('\n'));
    }
    return { create, update, del: [] };
  }

  if (!options.dryRun) {
    if (cleanRewriteOpenCodeShared) {
      await mkdir(path.dirname(cleanRewriteOpenCodeShared.absPath), { recursive: true });
      await writeFile(cleanRewriteOpenCodeShared.absPath, cleanRewriteOpenCodeShared.content, 'utf8');
    }
    for (const [manifestRelPath, next] of nextManifestsByRelPath) {
      if (next.records.length === 0) {
        await deleteManifest(targetRoot, manifestRelPath);
      } else {
        await saveManifest(targetRoot, manifestRelPath, next);
      }
    }
  }

  return { create, update, del };
}

export async function doctor(cwd: string, targets: ('claude' | 'codex' | 'opencode')[], kinds: ('agent' | 'skill' | 'mcp' | 'rule')[]): Promise<string[]> {
  const root = path.join(cwd, '.rac');
  const packs = await resolvePacks(cwd);
  const parsedAgents = [] as Awaited<ReturnType<typeof loadAgents>>;
  const parsedSkills = [] as Awaited<ReturnType<typeof loadSkills>>;
  const parsedMcps = [] as Awaited<ReturnType<typeof loadMcps>>;
  const parsedRules = [] as Awaited<ReturnType<typeof loadRules>>;
  for (const pack of packs) {
    if (kinds.includes('agent')) parsedAgents.push(...(await loadAgents(pack.root, pack.id)));
    if (kinds.includes('skill')) parsedSkills.push(...(await loadSkills(pack.root, pack.id)));
    if (kinds.includes('mcp')) parsedMcps.push(...(await loadMcps(pack.root, pack.id)));
    if (kinds.includes('rule')) parsedRules.push(...(await loadRules(pack.root, pack.id)));
  }
  assertNoCrossPackDuplicate(parsedAgents, 'agent');
  assertNoCrossPackDuplicate(parsedSkills, 'skill');
  assertNoCrossPackDuplicate(parsedMcps, 'mcp');
  assertNoCrossPackDuplicate(parsedRules, 'rule');
  const config = await buildRuntimeConfig({ root, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps, rules: parsedRules });

  const warnings: string[] = [];

  if (kinds.includes('mcp')) {
    for (const mcp of config.mcps) {
      for (const envRef of mcp.envRefs) {
        if (!process.env[envRef]) warnings.push(`missing env var: ${envRef} (referenced by mcp ${mcp.id})`);
      }
    }
  }

  if (kinds.includes('agent')) {
    if (targets.includes('opencode')) {
      warnings.push(...config.warnings.filter((warning) => warning.code === 'opencode_legacy_tools').map((warning) => warning.message));
    }
  }

  return warnings;
}
