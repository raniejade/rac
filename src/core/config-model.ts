import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentDef, McpDef, Pack, RuleDecision, RuleDef, SkillDef, Target, VendorConfigDef } from './types.js';
import { assertNoTraversal, rel } from './util.js';

export type ConfigWarning = {
  code: 'opencode_legacy_tools';
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
  instructionsIsTemplate: boolean;
  tools: string[];
  source: SourceInfo;
  vendor: {
    raw?: Record<string, unknown>;
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
  bodyIsTemplate: boolean;
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
  env?: Record<string, string>;
  envForward?: string[];
  vendorConfig?: {
    claude?: Record<string, unknown>;
    codex?: Record<string, unknown>;
    opencode?: Record<string, unknown>;
  };
  transport:
    | { kind: 'local'; command: string; args: string[] }
    | { kind: 'remote'; url: string };
};

export type RuntimeConfig = {
  pack: Pack;
  agents: AgentConfig[];
  skills: SkillConfig[];
  mcps: McpConfig[];
  rules: RuleConfig[];
  configs: VendorConfig[];
  warnings: ConfigWarning[];
};

export type VendorConfig = {
  pack: Pack;
  target: Target;
  source: SourceInfo;
  values: Record<string, unknown>;
  selectors: string[];
};

export type ToolRuleConfig = {
  decision: RuleDecision;
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
  configs?: VendorConfigDef[];
};

function sourceInfo(pack: Pack, root: string, absPath: string): SourceInfo {
  return { pack, absPath, relPath: rel(root, absPath) };
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

function selectorPath(selector: string): string[] {
  if (!selector.startsWith('$')) return [selector];
  const out: string[] = [];
  let i = 1;
  while (i < selector.length) {
    if (selector[i] !== '[') return [selector];
    const close = selector.indexOf(']', i);
    if (close < 0) return [selector];
    const parsed = JSON.parse(selector.slice(i + 1, close)) as unknown;
    if (typeof parsed !== 'string') return [selector];
    out.push(parsed);
    i = close + 1;
  }
  return out;
}

function selectorPathsOverlap(first: string[], second: string[]): boolean {
  const limit = Math.min(first.length, second.length);
  for (let i = 0; i < limit; i += 1) {
    if (first[i] !== second[i]) return false;
  }
  return true;
}

function assertNoConfigSelectorOverlap(configs: VendorConfigDef[]): void {
  const seen: Array<{ selector: string; path: string[]; owner: string; target: Target }> = [];
  for (const config of configs) {
    for (const selector of config.selectors) {
      const current = { selector, path: selectorPath(selector), owner: `${config.pack}:${config.sourceName}`, target: config.target };
      for (const prior of seen) {
        if (prior.target === current.target && selectorPathsOverlap(prior.path, current.path)) {
          throw new Error(`vendor config selector overlap for ${current.target}: ${prior.selector} from ${prior.owner} conflicts with ${current.selector} from ${current.owner}`);
        }
      }
      seen.push(current);
    }
  }
}

function expandRulePattern(pattern: Array<string | string[]>): string[][] {
  return pattern
    .map((segment) => Array.isArray(segment) ? segment : [segment])
    .reduce<string[][]>((acc, options) => {
      const next: string[][] = [];
      for (const base of acc) for (const option of options) next.push([...base, option]);
      return next;
    }, [[]]);
}

function validateNoRuleDecisionConflicts(rules: RuleDef[]): void {
  const byCommand = new Map<string, { decision: RuleDecision; ids: Set<string> }>();
  for (const rule of rules) {
    for (const command of expandRulePattern(rule.command)) {
      const key = `${command.join(' ')}${rule.append_wildcard ? ' *' : ''}`;
      const existing = byCommand.get(key);
      if (existing && existing.decision !== rule.decision) {
        const ids = [...existing.ids, rule.id].sort((a, b) => a.localeCompare(b));
        throw new Error(`conflicting rule decisions for command "${key}": ${ids.join(', ')}`);
      }
      if (existing) existing.ids.add(rule.id);
      else byCommand.set(key, { decision: rule.decision, ids: new Set([rule.id]) });
    }
  }
}

export async function buildRuntimeConfig(input: BuildRuntimeConfigInput): Promise<RuntimeConfig> {
  validateNoRuleDecisionConflicts(input.rules);
  const warnings: ConfigWarning[] = [];
  assertNoConfigSelectorOverlap(input.configs ?? []);

  const agents = await Promise.all(input.agents.map(async (agent): Promise<AgentConfig> => {
    let instructions = agent.instructions;
    if (instructions.startsWith('./') || instructions.startsWith('../')) {
      const instructionFile = assertNoTraversal(path.dirname(agent.sourcePath), instructions, 'agent instructions');
      instructions = await readFile(instructionFile, 'utf8');
    }

    const codexEmit = (agent.vendor?.codex as { emit?: unknown } | undefined)?.emit;
    if (codexEmit !== undefined) throw new Error(`agent ${agent.id} uses removed API: vendor.codex.emit`);
    const opencodeLegacyTools = Boolean((agent.vendor?.opencode as { tools?: unknown } | undefined)?.tools);
    const claudeConfig = targetVendorMap(agent.vendor, 'claude', 'config');
    const codexConfig = targetVendorMap(agent.vendor, 'codex', 'config');
    const opencodeConfig = targetVendorMap(agent.vendor, 'opencode', 'config');

    if (opencodeLegacyTools) warnings.push({ code: 'opencode_legacy_tools', message: `opencode vendor tools is legacy for agent ${agent.id}; prefer canonical tools` });

    return {
      pack: agent.pack,
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions,
      instructionsIsTemplate: Boolean(agent.instructionsIsTemplate),
      tools: agent.tools ?? [],
      source: sourceInfo(agent.pack, agent.packRoot, agent.sourcePath),
      vendor: {
        raw: agent.vendor,
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
        source: sourceInfo(skill.pack, skill.packRoot, sourceFile),
        hash: hashBuffer(content)
      };
    }));

    return {
      pack: skill.pack,
      id: skill.id,
      description: skill.description,
      body: skill.body,
      bodyIsTemplate: Boolean(skill.bodyIsTemplate),
      source: sourceInfo(skill.pack, skill.packRoot, skill.sourcePath),
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
    source: sourceInfo(mcp.pack, mcp.packRoot, mcp.sourcePath),
    envRefs: mcp.envVars,
    startupTimeoutMs: mcp.startup_timeout_ms,
    env: mcp.env,
    envForward: mcp.env_forward,
    vendorConfig: {
      claude: targetVendorMap(mcp.vendor, 'claude', 'config'),
      codex: targetVendorMap(mcp.vendor, 'codex', 'config'),
      opencode: targetVendorMap(mcp.vendor, 'opencode', 'config')
    },
    transport: mcp.command
      ? { kind: 'local', command: mcp.command, args: mcp.args ?? [] }
      : { kind: 'remote', url: String(mcp.url) }
  }));

  const rules: RuleConfig[] = input.rules.map((rule) => ({
    pack: rule.pack,
    id: rule.id,
    source: sourceInfo(rule.pack, rule.packRoot, rule.sourcePath),
    tools: [{
      decision: rule.decision,
      justification: rule.justification,
      pattern: rule.command,
      appendWildcard: rule.append_wildcard
    }]
  }));

  const configs: VendorConfig[] = (input.configs ?? []).map((config) => ({
    pack: config.pack,
    target: config.target,
    source: sourceInfo(config.pack, config.packRoot, config.sourcePath),
    values: config.values,
    selectors: config.selectors
  }));

  return { pack: 'project', agents, skills, mcps, rules, configs, warnings };
}
