import path from 'node:path';

import { stringify as stringifyToml } from 'smol-toml';

import type { RuntimeConfig, SkillAssetConfig } from '../core/config-model.js';
import { renderVendorTemplate } from '../core/template.js';
import type { Kind, ManagedInventoryEntry, Pack, Scope, Target } from '../core/types.js';
import { jsonPathBracketSelector, MANAGED_JSONC_WARNING, MANAGED_TOML_WARNING, sha256, tomlQuotedKeySegment } from '../core/util.js';

import { textManagedPayload } from './shared.js';

export type AdapterOutput = {
  pack: Pack;
  target: Target;
  kind: 'agent' | 'skill' | 'mcp' | 'rule' | 'config';
  id: string;
  source: string;
  relPath: string;
  manifestRelPath: string;
  inventory: ManagedInventoryEntry[];
  hash: string;
  content?: string;
  sourceFile?: string;
  isJson: boolean;
};

export type TargetAdapter = {
  target: Target;
  plan: (config: RuntimeConfig, scope: Scope) => AdapterOutput[];
};

function mergeGeneratedWithVendor(generated: Record<string, unknown>, vendor: Record<string, unknown> | undefined, context: string): Record<string, unknown> {
  if (!vendor) return generated;
  for (const key of Object.keys(vendor)) {
    if (Object.prototype.hasOwnProperty.call(generated, key)) {
      throw new Error(`${context} collides with generated key: ${key}`);
    }
  }
  return { ...generated, ...vendor };
}

function toTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => toTomlValue(entry)).join(', ')}]`;
  if (value && typeof value === 'object') throw new Error('nested object values are not supported in vendor config pass-through');
  throw new Error(`unsupported vendor config value type: ${typeof value}`);
}

function toTomlMultilineBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"""\n${escaped}"""`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function mergeObjectsDisjoint(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    const existingObj = asObject(existing);
    const valueObj = asObject(value);
    out[key] = existingObj && valueObj ? mergeObjectsDisjoint(existingObj, valueObj) : value;
  }
  return out;
}

function configValuesFor(config: RuntimeConfig, target: Target): Record<string, unknown> {
  return config.configs
    .filter((entry) => entry.target === target)
    .reduce<Record<string, unknown>>((acc, entry) => mergeObjectsDisjoint(acc, entry.values), {});
}

function configsFor(config: RuntimeConfig, target: Target): typeof config.configs {
  return config.configs.filter((entry) => entry.target === target);
}

function selectorToPath(selector: string): string[] {
  if (selector.startsWith('$[')) {
    const segments: string[] = [];
    let i = 1;
    while (i < selector.length) {
      const close = selector.indexOf(']', i);
      if (selector[i] !== '[' || close < 0) return [selector];
      const segment = JSON.parse(selector.slice(i + 1, close)) as unknown;
      if (typeof segment !== 'string') return [selector];
      segments.push(segment);
      i = close + 1;
    }
    return segments;
  }
  if (selector.startsWith('$.')) return selector.slice(2).split('.');
  const parts: string[] = [];
  let current = '';
  let i = 0;
  while (i < selector.length) {
    if (selector[i] === '.') {
      if (current) parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (selector[i] === '"') {
      let end = i + 1;
      while (end < selector.length) {
        if (selector[end] === '"' && selector[end - 1] !== '\\') break;
        end += 1;
      }
      if (end >= selector.length) return [selector];
      const quoted = selector.slice(i, end + 1);
      parts.push(JSON.parse(quoted) as string);
      i = end + 1;
      if (selector[i] === '.') i += 1;
      current = '';
      continue;
    }
    current += selector[i];
    i += 1;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [selector];
}

function pathsOverlap(first: string[], second: string[]): boolean {
  const limit = Math.min(first.length, second.length);
  for (let i = 0; i < limit; i += 1) if (first[i] !== second[i]) return false;
  return true;
}

function assertNoSelectorConflicts(configSelectors: string[], generatedSelectors: string[], context: string): void {
  if (configSelectors.length === 0) return;
  const configPaths = configSelectors.map((selector) => ({ selector, path: selectorToPath(selector) }));
  const generatedPaths = generatedSelectors.map((selector) => ({ selector, path: selectorToPath(selector) }));
  for (const configSelector of configPaths) {
    for (const generatedSelector of generatedPaths) {
      if (pathsOverlap(configSelector.path, generatedSelector.path)) {
        throw new Error(`${context} selector conflict: ${configSelector.selector} overlaps generated ${generatedSelector.selector}`);
      }
    }
  }
}

function selectorsForConfigs(config: RuntimeConfig, target: Target): string[] {
  return configsFor(config, target).flatMap((entry) => entry.selectors);
}

export function vendorManifestRelPath(target: Target, kind: Kind, scope: Scope = 'project'): string {
  if (target === 'claude') return '.claude/.rac-install-manifest.json';
  if (target === 'opencode') return `${opencodeDirFor(scope)}/.rac-install-manifest.json`;
  if (kind === 'skill') return '.agents/.rac-install-manifest.json';
  return '.codex/.rac-install-manifest.json';
}

function opencodeDirFor(scope: Scope): string {
  return scope === 'user' ? 'opencode' : '.opencode';
}

function skillAssetTargetPath(target: Target, skillId: string, asset: SkillAssetConfig, scope: Scope): string {
  if (target === 'claude') return path.posix.join('.claude/skills', skillId, asset.relativePath);
  if (target === 'codex') return path.posix.join('.agents/skills', skillId, asset.relativePath);
  return path.posix.join(opencodeDirFor(scope), 'skills', skillId, asset.relativePath);
}

function claudeAdapter(): TargetAdapter {
  return {
    target: 'claude',
    plan(config, scope) {
      const outputs: AdapterOutput[] = [];
      const claudeConfigValues = configValuesFor(config, 'claude');
      const claudeConfigs = configsFor(config, 'claude');

      for (const agent of config.agents) {
        const frontmatter = mergeGeneratedWithVendor(
          { name: agent.id, description: agent.description ?? agent.name ?? agent.id },
          agent.vendor.claudeConfig,
          `agent ${agent.id} vendor.claude.config`
        );
        const instructions = agent.instructionsIsTemplate ? renderVendorTemplate(agent.instructions, 'claude', `agent ${agent.id}`) : agent.instructions;
        const content = textManagedPayload(frontmatter, instructions);
        const relPath = `.claude/agents/${agent.id}.md`;
        outputs.push({ pack: agent.pack, target: 'claude', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'agent', scope), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const frontmatter = skill.claudeFrontmatter ?? skill.frontmatter;
        const body = skill.bodyIsTemplate ? renderVendorTemplate(skill.body, 'claude', `skill ${skill.id}`) : skill.body;
        const content = textManagedPayload(frontmatter, body);
        const relPath = `.claude/skills/${skill.id}/SKILL.md`;
        outputs.push({ pack: skill.pack, target: 'claude', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'skill', scope), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('claude', skill.id, asset, scope);
          outputs.push({ pack: asset.pack, target: 'claude', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'skill', scope), inventory: [{ version: 1, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0) {
        const relPath = scope === 'user' ? '.claude.json' : '.mcp.json';
        const mcpServers = Object.fromEntries([...config.mcps].sort((a, b) => a.id.localeCompare(b.id)).map((mcp) => [
          mcp.id,
          mergeGeneratedWithVendor(mcp.transport.kind === 'local'
            ? { command: mcp.transport.command, args: mcp.transport.args }
            : { url: mcp.transport.url }, mcp.vendorConfig?.claude, `mcp ${mcp.id} vendor.claude.config`
          )
        ]));
        const content = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
        for (const mcp of config.mcps) {
          outputs.push({ pack: mcp.pack, target: 'claude', kind: 'mcp', id: mcp.id, source: mcp.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'mcp', scope), inventory: [{ version: 1, format: 'json', selector: jsonPathBracketSelector(['mcpServers', mcp.id]) }], content, hash: sha256(content), isJson: true });
        }
      }

      if (config.rules.length > 0 || claudeConfigs.length > 0) {
        const relPath = '.claude/settings.json';
        const deny: string[] = [];
        const entriesByRuleId = new Map<string, string[]>();
        for (const rule of [...config.rules].sort((a, b) => a.id.localeCompare(b.id))) {
          const ruleEntries: string[] = [];
          for (const tool of rule.tools) {
            const segments = tool.pattern.map((segment) => Array.isArray(segment) ? segment : [segment]);
            const expanded = segments.reduce<string[][]>((acc, options) => {
              const next: string[][] = [];
              for (const base of acc) for (const option of options) next.push([...base, option]);
              return next;
            }, [[]]);
            for (const command of expanded) {
              const entry = `Bash(${command.join(' ')}${tool.appendWildcard ? ' *' : ''})`;
              deny.push(entry);
              ruleEntries.push(entry);
            }
          }
          entriesByRuleId.set(rule.id, ruleEntries);
        }
        assertNoSelectorConflicts(selectorsForConfigs(config, 'claude'), ['$.permissions.deny'], 'claude config');
        const generatedRuleConfig = config.rules.length > 0 ? { permissions: { deny } } : {};
        const content = `${JSON.stringify(mergeObjectsDisjoint(claudeConfigValues, generatedRuleConfig), null, 2)}\n`;
        for (const entry of claudeConfigs) {
          outputs.push({ pack: entry.pack, target: 'claude', kind: 'config', id: 'config', source: entry.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'config', scope), inventory: entry.selectors.map((selector) => ({ version: 1, format: 'json', selector })), content, hash: sha256(content), isJson: true });
        }
        for (const rule of config.rules) {
          outputs.push({ pack: rule.pack, target: 'claude', kind: 'rule', id: rule.id, source: rule.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'rule', scope), inventory: [{ version: 1, format: 'json', selector: '$.permissions.deny', entries: entriesByRuleId.get(rule.id) ?? [] }], content, hash: sha256(content), isJson: true });
        }
      }

      return outputs;
    }
  };
}

function codexAdapter(): TargetAdapter {
  function starlarkString(value: string): string {
    return JSON.stringify(value);
  }

  function starlarkStringList(values: string[]): string {
    return `[${values.map(starlarkString).join(', ')}]`;
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

  function renderCodexPrefixRule(pattern: string[], tool: { decision: string; justification: string }): string {
    return [
      'prefix_rule(',
      `  pattern = ${starlarkStringList(pattern)},`,
      `  decision = ${starlarkString(tool.decision)},`,
      `  justification = ${starlarkString(tool.justification)},`,
      ')'
    ].join('\n');
  }

  return {
    target: 'codex',
    plan(config, scope) {
      const outputs: AdapterOutput[] = [];
      const codexConfigValues = configValuesFor(config, 'codex');
      const codexConfigs = configsFor(config, 'codex');

      for (const agent of config.agents) {
        const instructions = agent.instructionsIsTemplate ? renderVendorTemplate(agent.instructions, 'codex', `agent ${agent.id}`) : agent.instructions;
        const generated: Record<string, unknown> = {
          name: agent.id,
          description: agent.description ?? agent.name ?? agent.id,
          developer_instructions: instructions
        };
        const merged = mergeGeneratedWithVendor(generated, agent.vendor.codexConfig, `agent ${agent.id} vendor.codex.config`);
        const lines = [MANAGED_TOML_WARNING];
        for (const [key, value] of Object.entries(merged)) {
          if (key === 'developer_instructions' && typeof value === 'string') {
            lines.push(`${key} = ${toTomlMultilineBasicString(value)}`);
          } else {
            lines.push(`${key} = ${toTomlValue(value)}`);
          }
        }
        const content = `${lines.join('\n')}\n`;
        const relPath = `.codex/agents/${agent.id}.toml`;
        outputs.push({ pack: agent.pack, target: 'codex', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'agent', scope), inventory: [{ version: 1, format: 'toml', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const body = skill.bodyIsTemplate ? renderVendorTemplate(skill.body, 'codex', `skill ${skill.id}`) : skill.body;
        const content = textManagedPayload(skill.codexFrontmatter ?? skill.frontmatter, body);
        const relPath = `.agents/skills/${skill.id}/SKILL.md`;
        outputs.push({ pack: skill.pack, target: 'codex', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'skill', scope), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('codex', skill.id, asset, scope);
          outputs.push({ pack: asset.pack, target: 'codex', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'skill', scope), inventory: [{ version: 1, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0 || codexConfigs.length > 0) {
        const mcpServers: Record<string, unknown> = {};
        const mcpSelectors: string[] = [];
        for (const mcp of [...config.mcps].sort((a, b) => a.id.localeCompare(b.id))) {
          mcpSelectors.push(`mcp_servers.${tomlQuotedKeySegment(mcp.id)}`);
          const generated: Record<string, unknown> = mcp.transport.kind === 'local'
            ? { command: mcp.transport.command, args: mcp.transport.args }
            : { url: mcp.transport.url };
          if (mcp.startupTimeoutMs) generated.startup_timeout_sec = Math.ceil(mcp.startupTimeoutMs / 1000);
          const merged = mergeGeneratedWithVendor(generated, mcp.vendorConfig?.codex, `mcp ${mcp.id} vendor.codex.config`);
          mcpServers[mcp.id] = merged;
        }
        assertNoSelectorConflicts(selectorsForConfigs(config, 'codex'), ['mcp_servers', ...mcpSelectors], 'codex config');
        const generatedTable = mergeObjectsDisjoint(codexConfigValues, config.mcps.length > 0 ? { mcp_servers: mcpServers } : {});
        const serialized = stringifyToml(generatedTable);
        const content = `${MANAGED_TOML_WARNING}\n${serialized}${serialized.endsWith('\n') ? '' : '\n'}`;
        for (const entry of codexConfigs) {
          outputs.push({ pack: entry.pack, target: 'codex', kind: 'config', id: 'config', source: entry.source.relPath, relPath: '.codex/config.toml', manifestRelPath: vendorManifestRelPath('codex', 'config', scope), inventory: entry.selectors.map((selector) => ({ version: 1, format: 'toml', selector })), content, hash: sha256(content), isJson: false });
        }
        for (const mcp of config.mcps) {
          const relPath = '.codex/config.toml';
          outputs.push({ pack: mcp.pack, target: 'codex', kind: 'mcp', id: mcp.id, source: mcp.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'mcp', scope), inventory: [{ version: 1, format: 'toml', selector: `mcp_servers.${tomlQuotedKeySegment(mcp.id)}` }], content, hash: sha256(content), isJson: false });
        }
      }

      if (config.rules.length > 0) {
        const bySource = new Map<string, typeof config.rules>();
        for (const rule of config.rules) {
          const key = `${rule.pack}::${rule.source.relPath}`;
          const existing = bySource.get(key) ?? [];
          existing.push(rule);
          bySource.set(key, existing);
        }
        for (const [sourceKey, sourceRules] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const lines = [MANAGED_TOML_WARNING];
          for (const rule of [...sourceRules].sort((a, b) => a.id.localeCompare(b.id))) {
            const tool = rule.tools[0];
            for (const pattern of expandRulePattern(tool.pattern)) {
              lines.push(renderCodexPrefixRule(pattern, tool));
            }
          }
          const content = `${lines.join('\n')}\n`;
          const [, source] = sourceKey.split('::', 2);
          const sourceFile = `${path.basename(source, path.extname(source))}.rules`;
          const relPath = `.codex/rules/${sourceFile}`;
          for (const rule of sourceRules) {
            outputs.push({ pack: rule.pack, target: 'codex', kind: 'rule', id: rule.id, source: rule.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'rule', scope), inventory: [{ version: 1, format: 'file', selector: '$' }], content, hash: sha256(content), isJson: false });
          }
        }
      }

      return outputs;
    }
  };
}

function opencodeAdapter(): TargetAdapter {
  return {
    target: 'opencode',
    plan(config, scope) {
      const outputs: AdapterOutput[] = [];
      const ocDir = opencodeDirFor(scope);
      const opencodeConfigValues = configValuesFor(config, 'opencode');
      const opencodeConfigs = configsFor(config, 'opencode');

      for (const agent of config.agents) {
        const frontmatter = mergeGeneratedWithVendor(
          { name: agent.id, description: agent.description ?? agent.name ?? agent.id },
          agent.vendor.opencodeConfig,
          `agent ${agent.id} vendor.opencode.config`
        );
        const instructions = agent.instructionsIsTemplate ? renderVendorTemplate(agent.instructions, 'opencode', `agent ${agent.id}`) : agent.instructions;
        const content = textManagedPayload(frontmatter, instructions);
        const relPath = `${ocDir}/agents/${agent.id}.md`;
        outputs.push({ pack: agent.pack, target: 'opencode', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'agent', scope), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const body = skill.bodyIsTemplate ? renderVendorTemplate(skill.body, 'opencode', `skill ${skill.id}`) : skill.body;
        const content = textManagedPayload(skill.opencodeFrontmatter ?? skill.frontmatter, body);
        const relPath = `${ocDir}/skills/${skill.id}/SKILL.md`;
        outputs.push({ pack: skill.pack, target: 'opencode', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'skill', scope), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('opencode', skill.id, asset, scope);
          outputs.push({ pack: asset.pack, target: 'opencode', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'skill', scope), inventory: [{ version: 1, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      const hasOpenCodeConfig = config.mcps.length > 0 || config.rules.length > 0 || opencodeConfigs.length > 0;
      if (hasOpenCodeConfig) {
        const mcp = Object.fromEntries([...config.mcps].sort((a, b) => a.id.localeCompare(b.id)).map((server) => [
          server.id,
          mergeGeneratedWithVendor(server.transport.kind === 'local'
            ? { type: 'local', enabled: true, command: [server.transport.command, ...server.transport.args] }
            : { type: 'remote', enabled: true, url: server.transport.url }, server.vendorConfig?.opencode, `mcp ${server.id} vendor.opencode.config`
          )
        ]));
        const bashDenyCommands = new Set<string>();
        const entriesByRuleId = new Map<string, string[]>();
        for (const rule of [...config.rules].sort((a, b) => a.id.localeCompare(b.id))) {
          const ruleEntries: string[] = [];
          for (const tool of rule.tools) {
            const segments = tool.pattern.map((segment) => Array.isArray(segment) ? segment : [segment]);
            const expanded = segments.reduce<string[][]>((acc, options) => {
              const next: string[][] = [];
              for (const base of acc) for (const option of options) next.push([...base, option]);
              return next;
            }, [[]]);
            for (const command of expanded) {
              const entry = `${command.join(' ')}${tool.appendWildcard ? ' *' : ''}`;
              bashDenyCommands.add(entry);
              ruleEntries.push(entry);
            }
          }
          entriesByRuleId.set(rule.id, ruleEntries);
        }
        const bash = Object.fromEntries(
          [...bashDenyCommands]
            .sort((a, b) => a.localeCompare(b))
            .map((command) => [command, 'deny'])
        );
        const generatedSelectors = [
          jsonPathBracketSelector(['mcp']),
          ...config.mcps.map((server) => jsonPathBracketSelector(['mcp', server.id])),
          '$.permission.bash'
        ];
        assertNoSelectorConflicts(selectorsForConfigs(config, 'opencode'), generatedSelectors, 'opencode config');
        const generatedConfig = mergeObjectsDisjoint(
          opencodeConfigValues,
          { ...(config.mcps.length > 0 ? { mcp } : {}), ...(config.rules.length > 0 ? { permission: { bash } } : {}) }
        );
        const content = `${MANAGED_JSONC_WARNING}\n${JSON.stringify(generatedConfig, null, 2)}\n`;
        const sharedRelPath = `${ocDir}/opencode.jsonc`;
        for (const entry of opencodeConfigs) {
          outputs.push({ pack: entry.pack, target: 'opencode', kind: 'config', id: 'config', source: entry.source.relPath, relPath: sharedRelPath, manifestRelPath: vendorManifestRelPath('opencode', 'config', scope), inventory: entry.selectors.map((selector) => ({ version: 1, format: 'json', selector })), content, hash: sha256(content), isJson: true });
        }
        for (const server of config.mcps) {
          outputs.push({ pack: server.pack, target: 'opencode', kind: 'mcp', id: server.id, source: server.source.relPath, relPath: sharedRelPath, manifestRelPath: vendorManifestRelPath('opencode', 'mcp', scope), inventory: [{ version: 1, format: 'json', selector: jsonPathBracketSelector(['mcp', server.id]) }], content, hash: sha256(content), isJson: true });
        }
        for (const rule of config.rules) {
          outputs.push({ pack: rule.pack, target: 'opencode', kind: 'rule', id: rule.id, source: rule.source.relPath, relPath: sharedRelPath, manifestRelPath: vendorManifestRelPath('opencode', 'rule', scope), inventory: [{ version: 1, format: 'json', selector: '$.permission.bash', entries: entriesByRuleId.get(rule.id) ?? [] }], content, hash: sha256(content), isJson: true });
        }
      }

      return outputs;
    }
  };
}

export const TARGET_ADAPTERS: TargetAdapter[] = [claudeAdapter(), codexAdapter(), opencodeAdapter()];

export function adapterFor(target: Target): TargetAdapter {
  const adapter = TARGET_ADAPTERS.find((entry) => entry.target === target);
  if (!adapter) throw new Error(`unsupported target: ${target}`);
  return adapter;
}
