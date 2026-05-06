import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { adapterFor, vendorManifestRelPath } from '../adapters/target-adapters.js';

import { buildRuntimeConfig } from './config-model.js';
import { deleteManifest, loadManifest, saveManifest } from './manifest.js';
import { loadAgents, loadMcps, loadRules, loadSkills } from './parsers.js';
import type { InstallManifest, InstallOptions, InstallResult, Kind, ManifestRecord, Target } from './types.js';
import { RAC_MARKER, FM_SENSITIVE_MARKER, sha256 } from './util.js';

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

function stableKey(record: Pick<ManifestRecord, 'target' | 'kind' | 'id' | 'relPath'>): string {
  return `${record.target}:${record.kind}:${record.id}:${record.relPath}`;
}

function sortManifestRecords(records: ManifestRecord[]): ManifestRecord[] {
  return [...records].sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
}

async function canOverwrite(filePath: string, ownedRelPaths: Set<string>, relPath: string, force: boolean, isJson: boolean): Promise<boolean> {
  if (!(await exists(filePath))) return true;
  if (force) return true;
  if (ownedRelPaths.has(relPath)) return true;
  if (isJson) return false;

  const existing = await readFile(filePath, 'utf8');
  return existing.includes(RAC_MARKER) || existing.includes(FM_SENSITIVE_MARKER);
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
  return record.target === 'opencode' && (record.kind === 'mcp' || record.kind === 'rule') && record.relPath === '.opencode/opencode.json';
}

function stableOpenCodeConfigJson(config: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(config, 'mcp')) ordered.mcp = config.mcp;
  if (Object.prototype.hasOwnProperty.call(config, 'permission')) ordered.permission = config.permission;
  for (const [key, value] of Object.entries(config).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'mcp' || key === 'permission') continue;
    ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function initProject(cwd: string, empty = false): Promise<void> {
  const root = path.join(cwd, '.rac');
  for (const dirName of ['agents', 'skills', 'mcps', 'rules']) {
    await mkdir(path.join(root, dirName), { recursive: true });
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
    manifestsByRelPath.set(relPath, await loadManifest(path.join(targetRoot, relPath)));
  }

  const ownedRelPaths = new Set<string>();
  for (const manifest of manifestsByRelPath.values()) {
    for (const record of manifest.records) ownedRelPaths.add(record.relPath);
  }

  const parsedAgents = options.kinds.includes('agent') ? await loadAgents(root) : [];
  const parsedSkills = options.kinds.includes('skill') ? await loadSkills(root) : [];
  const parsedMcps = options.kinds.includes('mcp') ? await loadMcps(root) : [];
  const parsedRules = options.kinds.includes('rule') ? await loadRules(root) : [];
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
        absPath: path.join(targetRoot, output.relPath),
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

  const opencodeSharedWrites = planByRelPath.get('.opencode/opencode.json') ?? [];
  let openCodeSharedManagedHashOverride: string | undefined;
  if (opencodeSharedWrites.length > 0) {
    const siblingKinds = new Set<Kind>();
    for (const record of recordsByRelPath.get('.opencode/opencode.json') ?? []) {
      if (!isManagedOpenCodeSharedJson(record)) continue;
      if (options.targets.includes(record.target) && !options.kinds.includes(record.kind)) siblingKinds.add(record.kind);
    }
    if (siblingKinds.size > 0 && (await exists(path.join(targetRoot, '.opencode/opencode.json')))) {
      const existingRaw = await readFile(path.join(targetRoot, '.opencode/opencode.json'), 'utf8');
      const existingParsed = JSON.parse(existingRaw) as Record<string, unknown>;
      const generatedParsed = JSON.parse(opencodeSharedWrites[0].content ?? '{}') as Record<string, unknown>;
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
      if (!(await canOverwrite(write.absPath, ownedRelPaths, write.relPath, !!options.force, !!write.isJson))) {
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
    const sharedRelPath = '.opencode/opencode.json';
    const absPath = path.join(targetRoot, sharedRelPath);
    const sharedManifestRecords = (recordsByRelPath.get(sharedRelPath) ?? []).filter(isManagedOpenCodeSharedJson);
    const hasUnselectedSibling = sharedManifestRecords.some((record) => !selected(record));
    if (hasUnselectedSibling && (await exists(absPath))) {
      const existingRaw = await readFile(absPath, 'utf8');
      const existingParsed = JSON.parse(existingRaw) as Record<string, unknown>;
      const generatedWrites = planByRelPath.get(sharedRelPath) ?? [];
      const generatedParsed = generatedWrites.length > 0
        ? (JSON.parse(generatedWrites[0].content ?? '{}') as Record<string, unknown>)
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
        const absPath = path.join(targetRoot, staleRecord.relPath);
        if (options.dryRun || options.check || seenDeletePath.has(absPath)) continue;
        if (await exists(absPath)) {
          await rm(absPath, { recursive: true, force: true });
          del.push(absPath);
          seenDeletePath.add(absPath);
        }
      }
    }
  }

  const nextManifestsByRelPath = new Map<string, InstallManifest>();
  const applySharedHashOverride = (record: ManifestRecord): ManifestRecord => {
    if (openCodeSharedManagedHashOverride && isManagedOpenCodeSharedJson(record)) return { ...record, hash: openCodeSharedManagedHashOverride };
    return record;
  };
  for (const [manifestRelPath, manifest] of manifestsByRelPath) {
    const keep = manifest.records.filter((record) => !selected(record)).map(applySharedHashOverride);
    const current = plan
      .filter((record) => record.manifestRelPath === manifestRelPath)
      .map(({ version, pack, target, kind, id, source, relPath, hash, inventory }) => applySharedHashOverride({ version, pack, target, kind, id, source, relPath, hash, inventory }));
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
        failures.push(`manifest would change: ${path.join(targetRoot, manifestRelPath)}`);
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
        failures.push(`stale managed output requires cleanup: ${path.join(targetRoot, staleRecord.relPath)}`);
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
      const manifestPath = path.join(targetRoot, manifestRelPath);
      if (next.records.length === 0) {
        await deleteManifest(manifestPath);
      } else {
        await saveManifest(manifestPath, next);
      }
    }
  }

  return { create, update, del };
}

export async function doctor(cwd: string, targets: ('claude' | 'codex' | 'opencode')[], kinds: ('agent' | 'skill' | 'mcp' | 'rule')[]): Promise<string[]> {
  const root = path.join(cwd, '.rac');

  const parsedAgents = kinds.includes('agent') ? await loadAgents(root) : [];
  const parsedSkills = kinds.includes('skill') ? await loadSkills(root) : [];
  const parsedMcps = kinds.includes('mcp') ? await loadMcps(root) : [];
  const parsedRules = kinds.includes('rule') ? await loadRules(root) : [];
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
    if (targets.includes('codex')) {
      warnings.push(...config.warnings.filter((warning) => warning.code === 'codex_instruction_only').map((warning) => warning.message));
    }
    if (targets.includes('opencode')) {
      warnings.push(...config.warnings.filter((warning) => warning.code === 'opencode_legacy_tools').map((warning) => warning.message));
    }
  }

  return warnings;
}
