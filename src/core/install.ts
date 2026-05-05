import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { adapterFor, vendorManifestRelPath } from '../adapters/target-adapters.js';

import { buildRuntimeConfig } from './config-model.js';
import { deleteManifest, loadManifest, saveManifest } from './manifest.js';
import { loadAgents, loadMcps, loadSkills } from './parsers.js';
import { sourceRoot } from './scope.js';
import type { InstallManifest, InstallOptions, InstallResult, Kind, ManifestRecord, Target } from './types.js';
import { AIRC_MARKER, FM_SENSITIVE_MARKER } from './util.js';

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

async function canOverwrite(filePath: string, ownedRelPaths: Set<string>, relPath: string, force: boolean, isJson: boolean): Promise<boolean> {
  if (!(await exists(filePath))) return true;
  if (force) return true;
  if (ownedRelPaths.has(relPath)) return true;
  if (isJson) return false;

  const existing = await readFile(filePath, 'utf8');
  return existing.includes(AIRC_MARKER) || existing.includes(FM_SENSITIVE_MARKER);
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

export async function initScope(scope: 'project' | 'user', cwd: string, empty = false): Promise<void> {
  const root = sourceRoot(scope, cwd);
  for (const dirName of ['agents', 'skills', 'mcps']) {
    await mkdir(path.join(root, dirName), { recursive: true });
  }
  if (empty) return;

  const reviewerToml = path.join(root, 'agents', 'reviewer.toml');
  const reviewerInstructions = path.join(root, 'agents', 'reviewer.instructions.md');
  const projectGatesSkill = path.join(root, 'skills', 'project-gates', 'SKILL.md');
  const projectRulesMcp = path.join(root, 'mcps', 'project-rules.toml');

  if (await exists(reviewerToml) || await exists(reviewerInstructions) || await exists(projectGatesSkill) || await exists(projectRulesMcp)) {
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
}

export async function install(options: InstallOptions): Promise<InstallResult> {
  const root = sourceRoot(options.scope, options.cwd);
  const targetRoot = options.scope === 'project' ? options.cwd : process.env.HOME || '';

  const manifestsByRelPath = new Map<string, InstallManifest>();
  for (const relPath of selectedManifestRelPaths(options.targets, options.kinds)) {
    manifestsByRelPath.set(relPath, await loadManifest(path.join(targetRoot, relPath)));
  }

  const ownedRelPaths = new Set<string>();
  for (const manifest of manifestsByRelPath.values()) {
    for (const record of manifest.records) ownedRelPaths.add(record.relPath);
  }

  const plan: PlannedWrite[] = [];

  const parsedAgents = options.kinds.includes('agent') ? await loadAgents(root) : [];
  const parsedSkills = options.kinds.includes('skill') ? await loadSkills(root) : [];
  const parsedMcps = options.kinds.includes('mcp') ? await loadMcps(root) : [];
  const config = await buildRuntimeConfig({ root, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps });

  for (const target of options.targets) {
    const adapter = adapterFor(target);
    const outputs = adapter.plan(config, options.scope);
    for (const output of outputs) {
      plan.push({
        version: 1,
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
      if (alreadyExists) update.push(write.absPath); else create.push(write.absPath);
      seenResultPath.add(write.absPath);
    }

    if (!options.dryRun && !appliedWriteByPath.has(write.absPath)) {
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

  const del: string[] = [];
  const seenDeletePath = new Set<string>();
  if (options.clean) {
    for (const staleRecords of staleByManifestRelPath.values()) {
      for (const staleRecord of staleRecords) {
        if (keptRelPaths.has(staleRecord.relPath)) continue;
        const absPath = path.join(targetRoot, staleRecord.relPath);
        if (options.dryRun || seenDeletePath.has(absPath)) continue;
        if (await exists(absPath)) {
          await rm(absPath, { recursive: true, force: true });
          del.push(absPath);
          seenDeletePath.add(absPath);
        }
      }
    }
  }

  if (!options.dryRun) {
    for (const [manifestRelPath, manifest] of manifestsByRelPath) {
      const keep = manifest.records.filter((record) => !selected(record));
      const current = plan
        .filter((record) => record.manifestRelPath === manifestRelPath)
        .map(({ version, target, kind, id, source, relPath, hash, inventory }) => ({ version, target, kind, id, source, relPath, hash, inventory }));
      const next = { version: 1 as const, records: [...keep, ...current] };
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

export async function doctor(scope: 'project' | 'user', cwd: string, targets: ('claude' | 'codex' | 'opencode')[], kinds: ('agent' | 'skill' | 'mcp')[]): Promise<string[]> {
  const root = sourceRoot(scope, cwd);

  const parsedAgents = kinds.includes('agent') ? await loadAgents(root) : [];
  const parsedSkills = kinds.includes('skill') ? await loadSkills(root) : [];
  const parsedMcps = kinds.includes('mcp') ? await loadMcps(root) : [];
  const config = await buildRuntimeConfig({ root, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps });

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
