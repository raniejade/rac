import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { emitAgent, emitMcps, emitSkill, skillAssetTargetPath } from '../adapters/emitters.js';
import { loadManifest, manifestPath, saveManifest } from './manifest.js';
import { loadAgents, loadMcps, loadSkills } from './parsers.js';
import { sourceRoot } from './scope.js';
import type { InstallManifest, InstallOptions, InstallResult, ManifestRecord } from './types.js';
import { AIRC_MARKER, FM_SENSITIVE_MARKER, assertNoTraversal, rel, sha256 } from './util.js';

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

  const agents = options.kinds.includes('agent') ? await loadAgents(root) : [];
  const skills = options.kinds.includes('skill') ? await loadSkills(root) : [];
  const mcps = options.kinds.includes('mcp') ? await loadMcps(root) : [];

  for (const target of options.targets) {
    for (const agent of agents) {
      let agentBody = agent.instructions;
      if (agent.instructions.startsWith('./') || agent.instructions.startsWith('../')) {
        const instructionFile = assertNoTraversal(path.dirname(agent.sourcePath), agent.instructions, 'agent instructions');
        agentBody = await readFile(instructionFile, 'utf8');
      }
      const emitted = emitAgent(target, { ...agent, instructions: agentBody });
      const content = emitted.content;
      const outPath = path.join(targetRoot, emitted.relPath);
      plan.push({
        version: 1,
        target,
        kind: 'agent',
        id: agent.id,
        source: rel(root, agent.sourcePath),
        path: outPath,
        hash: sha256(content),
        content,
        isJson: emitted.isJson
      });
    }

    for (const skill of skills) {
      const emitted = emitSkill(target, skill);
      const outPath = path.join(targetRoot, emitted.relPath);

      plan.push({
        version: 1,
        target,
        kind: 'skill',
        id: skill.id,
        source: rel(root, skill.sourcePath),
        path: outPath,
        hash: sha256(emitted.content),
        content: emitted.content,
        isJson: emitted.isJson
      });

      for (const assetRelativePath of skill.assets) {
        const sourceFile = assertNoTraversal(path.dirname(skill.sourcePath), assetRelativePath, 'skill asset');
        const targetRelativePath = skillAssetTargetPath(target, skill.id, assetRelativePath);
        const assetHash = crypto.createHash('sha256').update(await readFile(sourceFile)).digest('hex');
        plan.push({
          version: 1,
          target,
          kind: 'skill',
          id: skill.id,
          source: rel(root, sourceFile),
          path: path.join(targetRoot, targetRelativePath),
          hash: assetHash,
          sourceFile,
          isJson: false
        });
      }
    }

    if (mcps.length > 0) {
      const emitted = emitMcps(target, mcps, options.scope);
      const outPath = path.join(targetRoot, emitted.relPath);
      for (const mcp of mcps) {
        plan.push({
          version: 1,
          target,
          kind: 'mcp',
          id: mcp.id,
          source: rel(root, mcp.sourcePath),
          path: outPath,
          hash: sha256(emitted.content),
          content: emitted.content,
          isJson: emitted.isJson
        });
      }
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
  const warnings: string[] = [];
  const root = sourceRoot(scope, cwd);

  if (kinds.includes('mcp')) {
    const mcps = await loadMcps(root);
    for (const mcp of mcps) {
      for (const envVar of mcp.envVars) {
        if (!process.env[envVar]) {
          warnings.push(`missing env var: ${envVar} (referenced by mcp ${mcp.id})`);
        }
      }
    }
  }

  if (kinds.includes('agent') && targets.includes('codex')) {
    const agents = await loadAgents(root);
    for (const agent of agents) {
      const emit = (agent.vendor?.codex as { emit?: string } | undefined)?.emit;
      if (emit === 'instruction-only') {
        warnings.push(`codex instruction-only emit configured for agent ${agent.id}`);
      }
    }
  }

  if (kinds.includes('agent') && targets.includes('opencode')) {
    const agents = await loadAgents(root);
    for (const agent of agents) {
      const hasLegacyTools = Boolean((agent.vendor?.opencode as { tools?: unknown } | undefined)?.tools);
      if (hasLegacyTools) {
        warnings.push(`opencode vendor tools is legacy for agent ${agent.id}; prefer canonical tools`);
      }
    }
  }

  return warnings;
}
