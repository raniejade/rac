import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fg from 'fast-glob';
import { parse } from 'smol-toml';
import { z } from 'zod';

import type { AgentDef, McpDef, PackRuntime, PackSpec, RuleCommandItem, RuleDef, SkillDef } from './types.js';
import { collectEnvVarsFromText } from './util.js';

const PACK_ID_RE = /^[A-Za-z0-9._-]+$/;
const GITHUB_REPO_RE = /^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const REF_RE = /^\S+$/;

const agentSchema = z.object({ id: z.string().min(1), name: z.string().optional(), description: z.string().optional(), instructions: z.string().min(1), tools: z.array(z.string()).optional(), vendor: z.record(z.unknown()).optional() });
const skillSchema = z.object({ name: z.string().optional(), description: z.string().min(1), assets: z.array(z.string()).optional(), vendor: z.record(z.unknown()).optional() });
const mcpSchema = z.object({ id: z.string().min(1), command: z.string().optional(), args: z.array(z.string()).optional(), type: z.string().optional(), url: z.string().optional(), startup_timeout_ms: z.number().int().positive().optional(), vendor: z.record(z.unknown()).optional() }).superRefine((v, ctx) => {
  const hasLocal = !!v.command;
  const hasRemote = !!v.type && !!v.url;
  if (!hasLocal && !hasRemote) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp requires local command OR remote type+url' });
  if (hasLocal && hasRemote) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp cannot define both local and remote transport' });
});
const ruleSchema = z.object({ id: z.string().min(1), decision: z.string(), justification: z.string(), command: z.array(z.union([z.string(), z.array(z.string())])), append_wildcard: z.boolean().optional() });

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

async function runGit(args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
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
        resolve();
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

async function ensureSharedPack(spec: PackSpec): Promise<PackRuntime> {
  validatePackSpec(spec);
  const gitUrl = repoToGitUrl(spec.repo);
  const key = `${spec.repo}@${spec.ref}`;
  const keyHash = Buffer.from(key).toString('base64url');
  const repoDir = path.join(cacheRoot(), 'packs', keyHash);
  await mkdir(path.dirname(repoDir), { recursive: true });

  try {
    await stat(path.join(repoDir, '.git'));
  } catch {
    await runGit(['clone', gitUrl, repoDir]);
  }

  await runGit(['fetch', '--all', '--tags'], repoDir);
  await runGit(['checkout', '--detach', spec.ref], repoDir);

  const root = path.join(repoDir, '.rac');
  await loadSharedPackConfig(root);
  return { id: spec.id, root, sourceRepo: spec.repo, sourceRef: spec.ref };
}

function mapId<T extends { id: string }>(items: T[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`duplicate ${kind} id: ${item.id}`);
    seen.add(item.id);
  }
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

export async function loadSharedPackConfig(root: string): Promise<void> {
  const configPath = path.join(root, 'config.toml');
  const parsed = parseTomlOrThrow(configPath, await readFile(configPath, 'utf8'));
  if (parsed.packs !== undefined) throw new Error(`shared pack config cannot contain [[packs]]: ${configPath}`);
}

export async function resolvePacks(cwd: string): Promise<PackRuntime[]> {
  const projectRoot = path.join(cwd, '.rac');
  const configPath = path.join(projectRoot, 'config.toml');
  try { await stat(configPath); } catch { throw new Error(`missing required config: ${configPath}`); }

  const project = await loadProjectPackConfig(projectRoot);
  const out: PackRuntime[] = [{ id: 'project', root: projectRoot }];
  for (const spec of project.packs) out.push(await ensureSharedPack(spec));
  return out;
}

export async function loadAgents(root: string, packId: string): Promise<AgentDef[]> {
  const files = await fg('agents/*.toml', { cwd: root, absolute: true });
  const out = [] as AgentDef[];
  for (const file of files) {
    const parsed = agentSchema.parse(parseTomlOrThrow(file, await readFile(file, 'utf8')));
    out.push({ pack: packId, packRoot: root, ...parsed, sourcePath: file, sourceName: path.relative(root, file) });
  }
  mapId(out, 'agent');
  return out;
}

export async function loadSkills(root: string, packId: string): Promise<SkillDef[]> {
  const files = await fg('skills/*/SKILL.md', { cwd: root, absolute: true });
  const out: SkillDef[] = [];
  for (const file of files) {
    const id = path.basename(path.dirname(file));
    const raw = await readFile(file, 'utf8');
    if (!raw.startsWith('+++')) throw new Error(`skill frontmatter must start with +++ at byte 0: ${file}`);
    const closingIndex = raw.indexOf('\n+++\n', 3);
    if (closingIndex < 0) throw new Error(`missing closing +++ delimiter: ${file}`);
    const frontmatter = skillSchema.parse(parseTomlOrThrow(file, raw.slice(4, closingIndex + 1)));
    out.push({ pack: packId, packRoot: root, id, name: frontmatter.name, description: frontmatter.description, body: raw.slice(closingIndex + 5), frontmatter, assets: frontmatter.assets ?? [], sourcePath: file, sourceName: path.relative(root, file) });
  }
  mapId(out, 'skill');
  return out;
}

export async function loadMcps(root: string, packId: string): Promise<McpDef[]> {
  const files = await fg('mcps/*.toml', { cwd: root, absolute: true });
  const out = [] as McpDef[];
  for (const file of files) {
    const parsed = mcpSchema.parse(parseTomlOrThrow(file, await readFile(file, 'utf8')));
    out.push({ pack: packId, packRoot: root, ...parsed, envVars: collectEnvVarsFromText(JSON.stringify(parsed)), sourcePath: file, sourceName: path.relative(root, file) });
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
      if (parsed.decision !== 'forbidden') throw new Error(`unsupported rule decision for ${parsed.id}: ${parsed.decision}`);
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
      if (ids.has(parsed.id)) throw new Error(`duplicate rule id: ${parsed.id}`);
      ids.add(parsed.id);
      out.push({ pack: packId, packRoot: root, id: parsed.id, decision: 'forbidden', justification: parsed.justification, command: normalized, append_wildcard: parsed.append_wildcard ?? true, sourcePath: file, sourceName: path.relative(root, file) });
    }
  }
  return out;
}
