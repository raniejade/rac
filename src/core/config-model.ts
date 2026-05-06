import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentDef, McpDef, Pack, RuleDef, SkillDef } from './types.js';
import { assertNoTraversal, rel } from './util.js';

export type ConfigWarning = {
  code: 'codex_instruction_only' | 'opencode_legacy_tools';
  message: string;
};

export type SourceInfo = {
  pack: Pack;
  absPath: string;
  relPath: string;
};

export type AgentConfig = {
  pack: Pack;
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
    claudeConfig?: Record<string, unknown>;
    codexConfig?: Record<string, unknown>;
    opencodeConfig?: Record<string, unknown>;
  };
};

export type SkillAssetConfig = {
  pack: Pack;
  relativePath: string;
  source: SourceInfo;
  hash: string;
};

export type SkillConfig = {
  pack: Pack;
  id: string;
  description: string;
  body: string;
  source: SourceInfo;
  frontmatter: Record<string, unknown>;
  claudeFrontmatter?: Record<string, unknown>;
  codexFrontmatter?: Record<string, unknown>;
  opencodeFrontmatter?: Record<string, unknown>;
  assets: SkillAssetConfig[];
  vendorRaw?: Record<string, unknown>;
};

export type McpConfig = {
  pack: Pack;
  id: string;
  source: SourceInfo;
  envRefs: string[];
  startupTimeoutMs?: number;
  vendorConfig?: {
    claude?: Record<string, unknown>;
    codex?: Record<string, unknown>;
    opencode?: Record<string, unknown>;
  };
  transport:
    | { kind: 'local'; command: string; args: string[] }
    | { kind: 'remote'; type: string; url: string };
};

export type RuntimeConfig = {
  pack: Pack;
  agents: AgentConfig[];
  skills: SkillConfig[];
  mcps: McpConfig[];
  rules: RuleConfig[];
  warnings: ConfigWarning[];
};

export type ToolRuleConfig = {
  decision: 'forbidden';
  justification: string;
  pattern: Array<string | string[]>;
  appendWildcard: boolean;
};

export type RuleConfig = {
  pack: Pack;
  id: string;
  source: SourceInfo;
  tools: ToolRuleConfig[];
};

export type BuildRuntimeConfigInput = {
  root: string;
  agents: AgentDef[];
  skills: SkillDef[];
  mcps: McpDef[];
  rules: RuleDef[];
};

function sourceInfo(root: string, absPath: string): SourceInfo {
  return { pack: 'project', absPath, relPath: rel(root, absPath) };
}

function stripVendor(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...frontmatter };
  delete copy.vendor;
  return copy;
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function targetVendorMap(vendorRaw: Record<string, unknown> | undefined, target: 'claude' | 'codex' | 'opencode', key: 'config' | 'frontmatter'): Record<string, unknown> | undefined {
  const targetVendor = asMap(vendorRaw?.[target]);
  return asMap(targetVendor?.[key]);
}

function assertNoCollisions(overlay: Record<string, unknown> | undefined, generatedKeys: string[], message: string): void {
  if (!overlay) return;
  for (const key of generatedKeys) {
    if (Object.prototype.hasOwnProperty.call(overlay, key)) {
      throw new Error(`${message}: ${key}`);
    }
  }
}

function assertNoSharedKeys(first: Record<string, unknown> | undefined, second: Record<string, unknown> | undefined, message: string): void {
  if (!first || !second) return;
  for (const key of Object.keys(first)) {
    if (Object.prototype.hasOwnProperty.call(second, key)) {
      throw new Error(`${message}: ${key}`);
    }
  }
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
    const claudeConfig = targetVendorMap(agent.vendor, 'claude', 'config');
    const codexConfig = targetVendorMap(agent.vendor, 'codex', 'config');
    const opencodeConfig = targetVendorMap(agent.vendor, 'opencode', 'config');

    if (codexEmitInstructionOnly && codexConfig) {
      throw new Error(`agent ${agent.id} cannot combine vendor.codex.emit=instruction-only with vendor.codex.config`);
    }

    if (codexEmitInstructionOnly) warnings.push({ code: 'codex_instruction_only', message: `codex instruction-only emit configured for agent ${agent.id}` });
    if (opencodeLegacyTools) warnings.push({ code: 'opencode_legacy_tools', message: `opencode vendor tools is legacy for agent ${agent.id}; prefer canonical tools` });

    return {
      pack: agent.pack,
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions,
      tools: agent.tools ?? [],
      source: sourceInfo(input.root, agent.sourcePath),
      vendor: {
        raw: agent.vendor,
        codexEmitInstructionOnly,
        opencodeLegacyTools,
        claudeConfig,
        codexConfig,
        opencodeConfig
      }
    };
  }));

  const skills = await Promise.all(input.skills.map(async (skill): Promise<SkillConfig> => {
    const vendorRaw = skill.frontmatter.vendor as Record<string, unknown> | undefined;
    const claudeConfig = targetVendorMap(vendorRaw, 'claude', 'config');
    const codexConfig = targetVendorMap(vendorRaw, 'codex', 'config');
    const opencodeConfig = targetVendorMap(vendorRaw, 'opencode', 'config');
    const claudeFrontmatter = targetVendorMap(vendorRaw, 'claude', 'frontmatter');
    const codexFrontmatter = targetVendorMap(vendorRaw, 'codex', 'frontmatter');
    const opencodeFrontmatter = targetVendorMap(vendorRaw, 'opencode', 'frontmatter');

    assertNoCollisions(claudeConfig, ['name', 'description'], `skill ${skill.id} vendor.claude.config collides with generated keys`);
    assertNoCollisions(codexConfig, ['name', 'description'], `skill ${skill.id} vendor.codex.config collides with generated keys`);
    assertNoCollisions(opencodeConfig, ['name', 'description'], `skill ${skill.id} vendor.opencode.config collides with generated keys`);
    assertNoCollisions(claudeFrontmatter, ['name', 'description'], `skill ${skill.id} vendor.claude.frontmatter collides with generated keys`);
    assertNoCollisions(codexFrontmatter, ['name', 'description'], `skill ${skill.id} vendor.codex.frontmatter collides with generated keys`);
    assertNoCollisions(opencodeFrontmatter, ['name', 'description'], `skill ${skill.id} vendor.opencode.frontmatter collides with generated keys`);
    assertNoSharedKeys(claudeConfig, claudeFrontmatter, `skill ${skill.id} vendor.claude.config conflicts with vendor.claude.frontmatter`);
    assertNoSharedKeys(codexConfig, codexFrontmatter, `skill ${skill.id} vendor.codex.config conflicts with vendor.codex.frontmatter`);
    assertNoSharedKeys(opencodeConfig, opencodeFrontmatter, `skill ${skill.id} vendor.opencode.config conflicts with vendor.opencode.frontmatter`);

    const baseFrontmatter = stripVendor({ ...skill.frontmatter, name: skill.id, description: skill.description });
    const assets = await Promise.all((skill.assets ?? []).map(async (assetRelativePath): Promise<SkillAssetConfig> => {
      const sourceFile = assertNoTraversal(path.dirname(skill.sourcePath), assetRelativePath, 'skill asset');
      const content = await readFile(sourceFile);
      return {
        pack: skill.pack,
        relativePath: assetRelativePath,
        source: sourceInfo(input.root, sourceFile),
        hash: hashBuffer(content)
      };
    }));

    return {
      pack: skill.pack,
      id: skill.id,
      description: skill.description,
      body: skill.body,
      source: sourceInfo(input.root, skill.sourcePath),
      frontmatter: baseFrontmatter,
      claudeFrontmatter: (claudeConfig || claudeFrontmatter) ? { ...baseFrontmatter, ...(claudeConfig ?? {}), ...(claudeFrontmatter ?? {}) } : undefined,
      codexFrontmatter: (codexConfig || codexFrontmatter) ? { ...baseFrontmatter, ...(codexConfig ?? {}), ...(codexFrontmatter ?? {}) } : undefined,
      opencodeFrontmatter: (opencodeConfig || opencodeFrontmatter) ? { ...baseFrontmatter, ...(opencodeConfig ?? {}), ...(opencodeFrontmatter ?? {}) } : undefined,
      assets,
      vendorRaw
    };
  }));

  const mcps = input.mcps.map((mcp): McpConfig => ({
    pack: mcp.pack,
    id: mcp.id,
    source: sourceInfo(input.root, mcp.sourcePath),
    envRefs: mcp.envVars,
    startupTimeoutMs: mcp.startup_timeout_ms,
    vendorConfig: {
      claude: targetVendorMap(mcp.vendor, 'claude', 'config'),
      codex: targetVendorMap(mcp.vendor, 'codex', 'config'),
      opencode: targetVendorMap(mcp.vendor, 'opencode', 'config')
    },
    transport: mcp.command
      ? { kind: 'local', command: mcp.command, args: mcp.args ?? [] }
      : { kind: 'remote', type: String(mcp.type), url: String(mcp.url) }
  }));

  const rules: RuleConfig[] = input.rules.map((rule) => ({
    pack: rule.pack,
    id: rule.id,
    source: sourceInfo(input.root, rule.sourcePath),
    tools: [{
      decision: rule.decision,
      justification: rule.justification,
      pattern: rule.command,
      appendWildcard: rule.append_wildcard
    }]
  }));

  return { pack: 'project', agents, skills, mcps, rules, warnings };
}
