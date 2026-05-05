import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentDef, McpDef, SkillDef } from './types.js';
import { assertNoTraversal, rel } from './util.js';

export type ConfigWarning = {
  code: 'codex_instruction_only' | 'opencode_legacy_tools';
  message: string;
};

export type SourceInfo = {
  absPath: string;
  relPath: string;
};

export type AgentConfig = {
  id: string;
  name?: string;
  description?: string;
  instructions: string;
  tools: string[];
  source: SourceInfo;
  vendor: {
    raw?: Record<string, unknown>;
    codexEmitInstructionOnly: boolean;
    opencodeLegacyTools: boolean;
  };
};

export type SkillAssetConfig = {
  relativePath: string;
  source: SourceInfo;
  hash: string;
};

export type SkillConfig = {
  id: string;
  description: string;
  body: string;
  source: SourceInfo;
  frontmatter: Record<string, unknown>;
  claudeFrontmatter?: Record<string, unknown>;
  assets: SkillAssetConfig[];
  vendorRaw?: Record<string, unknown>;
};

export type McpConfig = {
  id: string;
  source: SourceInfo;
  envRefs: string[];
  startupTimeoutMs?: number;
  transport:
    | { kind: 'local'; command: string; args: string[] }
    | { kind: 'remote'; type: string; url: string };
};

export type RuntimeConfig = {
  agents: AgentConfig[];
  skills: SkillConfig[];
  mcps: McpConfig[];
  warnings: ConfigWarning[];
};

export type BuildRuntimeConfigInput = {
  root: string;
  agents: AgentDef[];
  skills: SkillDef[];
  mcps: McpDef[];
};

function sourceInfo(root: string, absPath: string): SourceInfo {
  return { absPath, relPath: rel(root, absPath) };
}

function stripVendor(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...frontmatter };
  delete copy.vendor;
  return copy;
}

function hashBuffer(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function buildRuntimeConfig(input: BuildRuntimeConfigInput): Promise<RuntimeConfig> {
  const warnings: ConfigWarning[] = [];

  const agents = await Promise.all(input.agents.map(async (agent): Promise<AgentConfig> => {
    let instructions = agent.instructions;
    if (instructions.startsWith('./') || instructions.startsWith('../')) {
      const instructionFile = assertNoTraversal(path.dirname(agent.sourcePath), instructions, 'agent instructions');
      instructions = await readFile(instructionFile, 'utf8');
    }

    const codexEmitInstructionOnly = (agent.vendor?.codex as { emit?: string } | undefined)?.emit === 'instruction-only';
    const opencodeLegacyTools = Boolean((agent.vendor?.opencode as { tools?: unknown } | undefined)?.tools);

    if (codexEmitInstructionOnly) {
      warnings.push({ code: 'codex_instruction_only', message: `codex instruction-only emit configured for agent ${agent.id}` });
    }
    if (opencodeLegacyTools) {
      warnings.push({ code: 'opencode_legacy_tools', message: `opencode vendor tools is legacy for agent ${agent.id}; prefer canonical tools` });
    }

    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions,
      tools: agent.tools ?? [],
      source: sourceInfo(input.root, agent.sourcePath),
      vendor: {
        raw: agent.vendor,
        codexEmitInstructionOnly,
        opencodeLegacyTools
      }
    };
  }));

  const skills = await Promise.all(input.skills.map(async (skill): Promise<SkillConfig> => {
    const vendor = skill.frontmatter.vendor as { claude?: { frontmatter?: Record<string, unknown> } } | undefined;
    const assets = await Promise.all((skill.assets ?? []).map(async (assetRelativePath): Promise<SkillAssetConfig> => {
      const sourceFile = assertNoTraversal(path.dirname(skill.sourcePath), assetRelativePath, 'skill asset');
      const content = await readFile(sourceFile);
      return {
        relativePath: assetRelativePath,
        source: sourceInfo(input.root, sourceFile),
        hash: hashBuffer(content)
      };
    }));

    return {
      id: skill.id,
      description: skill.description,
      body: skill.body,
      source: sourceInfo(input.root, skill.sourcePath),
      frontmatter: stripVendor({ ...skill.frontmatter, name: skill.id, description: skill.description }),
      claudeFrontmatter: vendor?.claude?.frontmatter,
      assets,
      vendorRaw: skill.frontmatter.vendor as Record<string, unknown> | undefined
    };
  }));

  const mcps = input.mcps.map((mcp): McpConfig => ({
    id: mcp.id,
    source: sourceInfo(input.root, mcp.sourcePath),
    envRefs: mcp.envVars,
    startupTimeoutMs: mcp.startup_timeout_ms,
    transport: mcp.command
      ? { kind: 'local', command: mcp.command, args: mcp.args ?? [] }
      : { kind: 'remote', type: String(mcp.type), url: String(mcp.url) }
  }));

  return { agents, skills, mcps, warnings };
}
