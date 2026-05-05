import { readFile } from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import { parse } from 'smol-toml';
import { z } from 'zod';

import type { AgentDef, McpDef, SkillDef } from './types.js';
import { collectEnvVarsFromText } from './util.js';

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().min(1),
  tools: z.array(z.string()).optional(),
  vendor: z.record(z.unknown()).optional()
});

const skillSchema = z.object({
  name: z.string().optional(),
  description: z.string().min(1),
  assets: z.array(z.string()).optional(),
  vendor: z.record(z.unknown()).optional()
});

const mcpSchema = z.object({
  id: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  type: z.string().optional(),
  url: z.string().optional(),
  startup_timeout_ms: z.number().int().positive().optional(),
  vendor: z.record(z.unknown()).optional()
}).superRefine((v, ctx) => {
  const hasLocal = !!v.command;
  const hasRemote = !!v.type && !!v.url;
  if (!hasLocal && !hasRemote) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp requires local command OR remote type+url' });
  }
  if (hasLocal && hasRemote) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcp cannot define both local and remote transport' });
  }
});

function parseTomlOrThrow(file: string, raw: string): Record<string, unknown> {
  try {
    return parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid TOML: ${file}: ${String((error as Error).message || error)}`);
  }
}

export async function loadAgents(root: string): Promise<AgentDef[]> {
  const files = await fg('agents/*.toml', { cwd: root, absolute: true });
  const ids = new Set<string>();
  const out: AgentDef[] = [];
  for (const file of files) {
    const parsed = agentSchema.parse(parseTomlOrThrow(file, await readFile(file, 'utf8')));
    if (ids.has(parsed.id)) throw new Error(`duplicate agent id: ${parsed.id}`);
    ids.add(parsed.id);
    out.push({
      pack: 'project',
      ...parsed,
      sourcePath: file,
      sourceName: path.relative(root, file)
    });
  }
  return out;
}

export async function loadSkills(root: string): Promise<SkillDef[]> {
  const files = await fg('skills/*/SKILL.md', { cwd: root, absolute: true });
  const ids = new Set<string>();
  const out: SkillDef[] = [];
  for (const file of files) {
    const id = path.basename(path.dirname(file));
    if (ids.has(id)) throw new Error(`duplicate skill id: ${id}`);
    ids.add(id);

    const raw = await readFile(file, 'utf8');
    if (!raw.startsWith('+++')) {
      throw new Error(`skill frontmatter must start with +++ at byte 0: ${file}`);
    }
    const closingIndex = raw.indexOf('\n+++\n', 3);
    if (closingIndex < 0) {
      throw new Error(`missing closing +++ delimiter: ${file}`);
    }

    const frontmatterBlock = raw.slice(4, closingIndex + 1);
    const frontmatter = skillSchema.parse(parseTomlOrThrow(file, frontmatterBlock));
    const body = raw.slice(closingIndex + 5);

    out.push({
      pack: 'project',
      id,
      name: frontmatter.name,
      description: frontmatter.description,
      body,
      frontmatter,
      assets: frontmatter.assets ?? [],
      sourcePath: file,
      sourceName: path.relative(root, file)
    });
  }
  return out;
}

export async function loadMcps(root: string): Promise<McpDef[]> {
  const files = await fg('mcps/*.toml', { cwd: root, absolute: true });
  const ids = new Set<string>();
  const out: McpDef[] = [];
  for (const file of files) {
    const parsed = mcpSchema.parse(parseTomlOrThrow(file, await readFile(file, 'utf8')));
    if (ids.has(parsed.id)) throw new Error(`duplicate mcp id: ${parsed.id}`);
    ids.add(parsed.id);

    const envVars = collectEnvVarsFromText(JSON.stringify(parsed));
    out.push({
      pack: 'project',
      ...parsed,
      envVars,
      sourcePath: file,
      sourceName: path.relative(root, file)
    });
  }
  return out;
}
