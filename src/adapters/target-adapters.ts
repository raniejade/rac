import path from 'node:path';

import type { RuntimeConfig, SkillAssetConfig } from '../core/config-model.js';
import type { Kind, ManagedInventoryEntry, Pack, Target } from '../core/types.js';
import { RAC_MARKER, sha256 } from '../core/util.js';

import { textManagedPayload } from './shared.js';

export type AdapterOutput = {
  pack: Pack;
  target: Target;
  kind: 'agent' | 'skill' | 'mcp' | 'rule';
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
  plan: (config: RuntimeConfig) => AdapterOutput[];
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

export function vendorManifestRelPath(target: Target, kind: Kind): string {
  if (target === 'claude') return '.claude/.rac-install-manifest.json';
  if (target === 'opencode') return '.opencode/.rac-install-manifest.json';
  if (kind === 'skill') return '.agents/.rac-install-manifest.json';
  return '.codex/.rac-install-manifest.json';
}

function skillAssetTargetPath(target: Target, skillId: string, asset: SkillAssetConfig): string {
  if (target === 'claude') return path.join('.claude/skills', skillId, asset.relativePath);
  if (target === 'codex') return path.join('.agents/skills', skillId, asset.relativePath);
  return path.join('.opencode/skills', skillId, asset.relativePath);
}

function claudeAdapter(): TargetAdapter {
  return {
    target: 'claude',
    plan(config) {
      const outputs: AdapterOutput[] = [];

      for (const agent of config.agents) {
        const frontmatter = mergeGeneratedWithVendor(
          { name: agent.id, description: agent.description ?? agent.name ?? agent.id },
          agent.vendor.claudeConfig,
          `agent ${agent.id} vendor.claude.config`
        );
        const content = textManagedPayload(frontmatter, agent.instructions);
        const relPath = `.claude/agents/${agent.id}.md`;
        outputs.push({ pack: 'project', target: 'claude', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'agent'), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const frontmatter = skill.claudeFrontmatter ?? skill.frontmatter;
        const content = textManagedPayload(frontmatter, skill.body);
        const relPath = `.claude/skills/${skill.id}/SKILL.md`;
        outputs.push({ pack: 'project', target: 'claude', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'skill'), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('claude', skill.id, asset);
          outputs.push({ pack: 'project', target: 'claude', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'skill'), inventory: [{ version: 1, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0) {
        const relPath = '.mcp.json';
        const mcpServers = Object.fromEntries([...config.mcps].sort((a, b) => a.id.localeCompare(b.id)).map((mcp) => [
          mcp.id,
          mergeGeneratedWithVendor(mcp.transport.kind === 'local'
            ? { command: mcp.transport.command, args: mcp.transport.args }
            : { type: mcp.transport.type, url: mcp.transport.url }, mcp.vendorConfig?.claude, `mcp ${mcp.id} vendor.claude.config`
          )
        ]));
        const content = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
        for (const mcp of config.mcps) {
          outputs.push({ pack: 'project', target: 'claude', kind: 'mcp', id: mcp.id, source: mcp.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'mcp'), inventory: [{ version: 1, format: 'json', selector: `$.mcpServers.${mcp.id}` }], content, hash: sha256(content), isJson: true });
        }
      }

      if (config.rules.length > 0) {
        const relPath = '.claude/settings.json';
        const deny: string[] = [];
        for (const rule of [...config.rules].sort((a, b) => a.id.localeCompare(b.id))) {
          for (const tool of rule.tools) {
            const segments = tool.pattern.map((segment) => Array.isArray(segment) ? segment : [segment]);
            const expanded = segments.reduce<string[][]>((acc, options) => {
              const next: string[][] = [];
              for (const base of acc) for (const option of options) next.push([...base, option]);
              return next;
            }, [[]]);
            for (const command of expanded) {
              deny.push(`Bash(${command.join(' ')}${tool.appendWildcard ? ' *' : ''})`);
            }
          }
        }
        const content = `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`;
        for (const rule of config.rules) {
          outputs.push({ pack: 'project', target: 'claude', kind: 'rule', id: rule.id, source: rule.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'rule'), inventory: [{ version: 1, format: 'json', selector: '$.permissions.deny' }], content, hash: sha256(content), isJson: true });
        }
      }

      return outputs;
    }
  };
}

function codexAdapter(): TargetAdapter {
  return {
    target: 'codex',
    plan(config) {
      const outputs: AdapterOutput[] = [];

      for (const agent of config.agents) {
        const frontmatter = mergeGeneratedWithVendor(
          { name: agent.id, description: agent.description ?? agent.name ?? agent.id },
          agent.vendor.codexConfig,
          `agent ${agent.id} vendor.codex.config`
        );
        if (agent.vendor.codexEmitInstructionOnly) {
          const content = textManagedPayload(frontmatter, agent.instructions);
          const relPath = `.codex/agents/${agent.id}.md`;
          outputs.push({ pack: 'project', target: 'codex', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'agent'), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        } else {
          const generated: Record<string, unknown> = {
            name: agent.id,
            description: agent.description ?? agent.name ?? agent.id,
            developer_instructions: agent.instructions
          };
          const merged = mergeGeneratedWithVendor(generated, agent.vendor.codexConfig, `agent ${agent.id} vendor.codex.config`);
          const lines = [RAC_MARKER];
          for (const [key, value] of Object.entries(merged)) lines.push(`${key} = ${toTomlValue(value)}`);
          const content = `${lines.join('\n')}\n`;
          const relPath = `.codex/agents/${agent.id}.toml`;
          outputs.push({ pack: 'project', target: 'codex', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'agent'), inventory: [{ version: 1, format: 'toml', selector: '$' }], content, hash: sha256(content), isJson: false });
        }
      }

      for (const skill of config.skills) {
        const content = textManagedPayload(skill.codexFrontmatter ?? skill.frontmatter, skill.body);
        const relPath = `.agents/skills/${skill.id}/SKILL.md`;
        outputs.push({ pack: 'project', target: 'codex', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'skill'), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('codex', skill.id, asset);
          outputs.push({ pack: 'project', target: 'codex', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'skill'), inventory: [{ version: 1, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0) {
        const lines = [RAC_MARKER];
        for (const mcp of [...config.mcps].sort((a, b) => a.id.localeCompare(b.id))) {
          lines.push(`[mcp_servers.${mcp.id}]`);
          const generated: Record<string, unknown> = mcp.transport.kind === 'local'
            ? { command: mcp.transport.command, args: mcp.transport.args }
            : { type: mcp.transport.type, url: mcp.transport.url };
          if (mcp.startupTimeoutMs) generated.startup_timeout_sec = Math.ceil(mcp.startupTimeoutMs / 1000);
          const merged = mergeGeneratedWithVendor(generated, mcp.vendorConfig?.codex, `mcp ${mcp.id} vendor.codex.config`);
          for (const [key, value] of Object.entries(merged)) lines.push(`${key} = ${toTomlValue(value)}`);
          lines.push('');
        }
        const content = `${lines.join('\n').trimEnd()}\n`;
        for (const mcp of config.mcps) {
          const relPath = '.codex/config.toml';
          outputs.push({ pack: 'project', target: 'codex', kind: 'mcp', id: mcp.id, source: mcp.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'mcp'), inventory: [{ version: 1, format: 'toml', selector: `mcp_servers.${mcp.id}` }], content, hash: sha256(content), isJson: false });
        }
      }

      if (config.rules.length > 0) {
        const bySource = new Map<string, typeof config.rules>();
        for (const rule of config.rules) {
          const existing = bySource.get(rule.source.relPath) ?? [];
          existing.push(rule);
          bySource.set(rule.source.relPath, existing);
        }
        for (const [source, sourceRules] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          const lines = [RAC_MARKER];
          for (const rule of [...sourceRules].sort((a, b) => a.id.localeCompare(b.id))) {
            const tool = rule.tools[0];
            lines.push(`prefix_rule(${JSON.stringify(tool.pattern)}, ${JSON.stringify(tool.decision)}, ${JSON.stringify(tool.justification)}, ${tool.appendWildcard ? 'true' : 'false'})`);
          }
          const content = `${lines.join('\n')}\n`;
          const sourceBase = path.basename(source, path.extname(source));
          const relPath = `.codex/rules/${sourceBase}.rules`;
          for (const rule of sourceRules) {
            outputs.push({ pack: 'project', target: 'codex', kind: 'rule', id: rule.id, source: rule.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'rule'), inventory: [{ version: 1, format: 'file', selector: '$' }], content, hash: sha256(content), isJson: false });
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
    plan(config) {
      const outputs: AdapterOutput[] = [];

      for (const agent of config.agents) {
        const frontmatter = mergeGeneratedWithVendor(
          { name: agent.id, description: agent.description ?? agent.name ?? agent.id },
          agent.vendor.opencodeConfig,
          `agent ${agent.id} vendor.opencode.config`
        );
        const content = textManagedPayload(frontmatter, agent.instructions);
        const relPath = `.opencode/agents/${agent.id}.md`;
        outputs.push({ pack: 'project', target: 'opencode', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'agent'), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const content = textManagedPayload(skill.opencodeFrontmatter ?? skill.frontmatter, skill.body);
        const relPath = `.opencode/skills/${skill.id}/SKILL.md`;
        outputs.push({ pack: 'project', target: 'opencode', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'skill'), inventory: [{ version: 1, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('opencode', skill.id, asset);
          outputs.push({ pack: 'project', target: 'opencode', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'skill'), inventory: [{ version: 1, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      const hasOpenCodeConfig = config.mcps.length > 0 || config.rules.length > 0;
      if (hasOpenCodeConfig) {
        const mcp = Object.fromEntries([...config.mcps].sort((a, b) => a.id.localeCompare(b.id)).map((server) => [
          server.id,
          mergeGeneratedWithVendor(server.transport.kind === 'local'
            ? { type: 'local', enabled: true, command: [server.transport.command, ...server.transport.args] }
            : { type: 'remote', enabled: true, url: server.transport.url }, server.vendorConfig?.opencode, `mcp ${server.id} vendor.opencode.config`
          )
        ]));
        const bashDenyCommands = new Set<string>();
        for (const rule of [...config.rules].sort((a, b) => a.id.localeCompare(b.id))) {
          for (const tool of rule.tools) {
            const segments = tool.pattern.map((segment) => Array.isArray(segment) ? segment : [segment]);
            const expanded = segments.reduce<string[][]>((acc, options) => {
              const next: string[][] = [];
              for (const base of acc) for (const option of options) next.push([...base, option]);
              return next;
            }, [[]]);
            for (const command of expanded) {
              bashDenyCommands.add(`${command.join(' ')}${tool.appendWildcard ? ' *' : ''}`);
            }
          }
        }
        const bash = Object.fromEntries(
          [...bashDenyCommands]
            .sort((a, b) => a.localeCompare(b))
            .map((command) => [command, 'deny'])
        );
        const content = `${JSON.stringify({ ...(config.mcps.length > 0 ? { mcp } : {}), ...(config.rules.length > 0 ? { permission: { bash } } : {}) }, null, 2)}\n`;
        for (const server of config.mcps) {
          const relPath = '.opencode/opencode.json';
          outputs.push({ pack: 'project', target: 'opencode', kind: 'mcp', id: server.id, source: server.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'mcp'), inventory: [{ version: 1, format: 'json', selector: `$.mcp.${server.id}` }], content, hash: sha256(content), isJson: true });
        }
        for (const rule of config.rules) {
          const relPath = '.opencode/opencode.json';
          outputs.push({ pack: 'project', target: 'opencode', kind: 'rule', id: rule.id, source: rule.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'rule'), inventory: [{ version: 1, format: 'json', selector: '$.permission.bash' }], content, hash: sha256(content), isJson: true });
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
