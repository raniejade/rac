import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { adapterFor } from '../adapters/target-adapters.js';

import { buildRuntimeConfig } from './config-model.js';
import { loadManifest, manifestPath, saveManifest } from './manifest.js';
import { loadAgents, loadMcps, loadSkills } from './parsers.js';
import { sourceRoot } from './scope.js';
import type { InstallManifest, InstallOptions, InstallResult, ManifestRecord } from './types.js';
import { AIRC_MARKER, FM_SENSITIVE_MARKER } from './util.js';

type PlannedWrite = ManifestRecord & {
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

function isManifestOwned(filePath: string, manifest: InstallManifest): boolean {
  return manifest.records.some((record) => record.path === filePath);
}

async function canOverwrite(filePath: string, manifest: InstallManifest, force: boolean, isJson: boolean): Promise<boolean> {
  if (!(await exists(filePath))) return true;
  if (force) return true;
  if (isManifestOwned(filePath, manifest)) return true;
  if (isJson) return false;

  const existing = await readFile(filePath, 'utf8');
  return existing.includes(AIRC_MARKER) || existing.includes(FM_SENSITIVE_MARKER);
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

  const manifestFile = manifestPath(options.scope, options.cwd);
  const manifest = await loadManifest(manifestFile);
  const plan: PlannedWrite[] = [];

  const parsedAgents = options.kinds.includes('agent') ? await loadAgents(root) : [];
  const parsedSkills = options.kinds.includes('skill') ? await loadSkills(root) : [];
  const parsedMcps = options.kinds.includes('mcp') ? await loadMcps(root) : [];
  const config = await buildRuntimeConfig({ root, agents: parsedAgents, skills: parsedSkills, mcps: parsedMcps });

  for (const target of options.targets) {
    const adapter = adapterFor(target);
    const outputs = adapter.plan(config, options.scope);
    for (const output of outputs) {
      const outPath = path.join(targetRoot, output.relPath);
      plan.push({
        version: 1,
        target: output.target,
        kind: output.kind,
        id: output.id,
        source: output.source,
        path: outPath,
        hash: output.hash,
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
    if (!checkedOverwritePath.has(write.path)) {
      if (!(await canOverwrite(write.path, manifest, !!options.force, !!write.isJson))) {
        throw new Error(`refusing overwrite unmanaged file: ${write.path}`);
      }
      checkedOverwritePath.add(write.path);
    }

    const alreadyExists = await exists(write.path);
    if (!seenResultPath.has(write.path)) {
      if (alreadyExists) update.push(write.path); else create.push(write.path);
      seenResultPath.add(write.path);
    }

    if (!options.dryRun && !appliedWriteByPath.has(write.path)) {
      await mkdir(path.dirname(write.path), { recursive: true });
      if (write.sourceFile) {
        await copyFile(write.sourceFile, write.path);
      } else {
        await writeFile(write.path, write.content ?? '', 'utf8');
      }
      appliedWriteByPath.add(write.path);
    }
  }

  const selected = (record: ManifestRecord): boolean => options.targets.includes(record.target) && options.kinds.includes(record.kind);
  const liveKeys = new Set(plan.map((entry) => `${entry.target}:${entry.kind}:${entry.id}:${entry.path}`));
  const stale = manifest.records.filter((record) => selected(record) && !liveKeys.has(`${record.target}:${record.kind}:${record.id}:${record.path}`));
  const keptOrCurrentPathRefs = new Set([
    ...manifest.records.filter((record) => !selected(record)).map((record) => record.path),
    ...plan.map((entry) => entry.path)
  ]);

  const del: string[] = [];
  const seenDeletePath = new Set<string>();
  if (options.clean) {
    for (const staleRecord of stale) {
      const isStillReferenced = keptOrCurrentPathRefs.has(staleRecord.path);
      if (isStillReferenced || options.dryRun || seenDeletePath.has(staleRecord.path)) {
        continue;
      }
      if (await exists(staleRecord.path)) {
        await rm(staleRecord.path, { recursive: true, force: true });
        del.push(staleRecord.path);
        seenDeletePath.add(staleRecord.path);
      }
    }
  }

  if (!options.dryRun) {
    const keep = manifest.records.filter((record) => !selected(record));
    const current = plan.map(({ version, target, kind, id, source, path, hash }) => ({ version, target, kind, id, source, path, hash }));
    await saveManifest(manifestFile, { version: 1, records: [...keep, ...current] });
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
