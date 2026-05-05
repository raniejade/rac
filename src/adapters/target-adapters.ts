import path from 'node:path';

import type { RuntimeConfig, SkillAssetConfig } from '../core/config-model.js';
import type { Kind, ManagedInventoryEntry, Scope, Target } from '../core/types.js';
import { AIRC_MARKER, sha256 } from '../core/util.js';

import { textManagedPayload } from './shared.js';

export type AdapterOutput = {
  target: Target;
  kind: 'agent' | 'skill' | 'mcp';
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

export function vendorManifestRelPath(target: Target, kind: Kind): string {
  if (target === 'claude') return '.claude/.airc-install-manifest.json';
  if (target === 'opencode') return '.opencode/.airc-install-manifest.json';
  if (kind === 'skill') return '.agents/.airc-install-manifest.json';
  return '.codex/.airc-install-manifest.json';
}

function skillAssetTargetPath(target: Target, skillId: string, asset: SkillAssetConfig): string {
  if (target === 'claude') return path.join('.claude/skills', skillId, asset.relativePath);
  if (target === 'codex') return path.join('.agents/skills', skillId, asset.relativePath);
  return path.join('.opencode/skills', skillId, asset.relativePath);
}

function claudeAdapter(): TargetAdapter {
  return {
    target: 'claude',
    plan(config, scope) {
      const outputs: AdapterOutput[] = [];

      for (const agent of config.agents) {
        const frontmatter = { name: agent.id, description: agent.description ?? agent.name ?? agent.id };
        const content = textManagedPayload(frontmatter, agent.instructions);
        const relPath = `.claude/agents/${agent.id}.md`;
        outputs.push({ target: 'claude', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'agent'), inventory: [{ version: 1, relPath, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const frontmatter = skill.claudeFrontmatter ?? skill.frontmatter;
        const content = textManagedPayload(frontmatter, skill.body);
        const relPath = `.claude/skills/${skill.id}/SKILL.md`;
        outputs.push({ target: 'claude', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'skill'), inventory: [{ version: 1, relPath, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('claude', skill.id, asset);
          outputs.push({ target: 'claude', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'skill'), inventory: [{ version: 1, relPath, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0) {
        const relPath = scope === 'project' ? '.mcp.json' : '.claude.json';
        const mcpServers = Object.fromEntries([...config.mcps].sort((a, b) => a.id.localeCompare(b.id)).map((mcp) => [
          mcp.id,
          mcp.transport.kind === 'local'
            ? { command: mcp.transport.command, args: mcp.transport.args }
            : { type: mcp.transport.type, url: mcp.transport.url }
        ]));
        const content = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
        for (const mcp of config.mcps) {
          outputs.push({ target: 'claude', kind: 'mcp', id: mcp.id, source: mcp.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('claude', 'mcp'), inventory: [{ version: 1, relPath, format: 'json', selector: `$.mcpServers.${mcp.id}` }], content, hash: sha256(content), isJson: true });
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
        const frontmatter = { name: agent.id, description: agent.description ?? agent.name ?? agent.id };
        if (agent.vendor.codexEmitInstructionOnly) {
          const content = textManagedPayload(frontmatter, agent.instructions);
          const relPath = `.codex/agents/${agent.id}.md`;
          outputs.push({ target: 'codex', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'agent'), inventory: [{ version: 1, relPath, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        } else {
          const content = `${AIRC_MARKER}\nname = ${JSON.stringify(agent.id)}\ndescription = ${JSON.stringify(agent.description ?? agent.name ?? agent.id)}\ndeveloper_instructions = ${JSON.stringify(agent.instructions)}\n`;
          const relPath = `.codex/agents/${agent.id}.toml`;
          outputs.push({ target: 'codex', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'agent'), inventory: [{ version: 1, relPath, format: 'toml', selector: '$' }], content, hash: sha256(content), isJson: false });
        }
      }

      for (const skill of config.skills) {
        const content = textManagedPayload(skill.frontmatter, skill.body);
        const relPath = `.agents/skills/${skill.id}/SKILL.md`;
        outputs.push({ target: 'codex', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'skill'), inventory: [{ version: 1, relPath, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('codex', skill.id, asset);
          outputs.push({ target: 'codex', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'skill'), inventory: [{ version: 1, relPath, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0) {
        const lines = [AIRC_MARKER];
        for (const mcp of [...config.mcps].sort((a, b) => a.id.localeCompare(b.id))) {
          lines.push(`[mcp_servers.${mcp.id}]`);
          if (mcp.transport.kind === 'local') {
            lines.push(`command = ${JSON.stringify(mcp.transport.command)}`);
            lines.push(`args = [${mcp.transport.args.map((v) => JSON.stringify(v)).join(', ')}]`);
          } else {
            lines.push(`type = ${JSON.stringify(mcp.transport.type)}`);
            lines.push(`url = ${JSON.stringify(mcp.transport.url)}`);
          }
          if (mcp.startupTimeoutMs) lines.push(`startup_timeout_sec = ${Math.ceil(mcp.startupTimeoutMs / 1000)}`);
          lines.push('');
        }
        const content = `${lines.join('\n').trimEnd()}\n`;
        for (const mcp of config.mcps) {
          const relPath = '.codex/config.toml';
          outputs.push({ target: 'codex', kind: 'mcp', id: mcp.id, source: mcp.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('codex', 'mcp'), inventory: [{ version: 1, relPath, format: 'toml', selector: `mcp_servers.${mcp.id}` }], content, hash: sha256(content), isJson: false });
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
        const frontmatter = { name: agent.id, description: agent.description ?? agent.name ?? agent.id };
        const content = textManagedPayload(frontmatter, agent.instructions);
        const relPath = `.opencode/agents/${agent.id}.md`;
        outputs.push({ target: 'opencode', kind: 'agent', id: agent.id, source: agent.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'agent'), inventory: [{ version: 1, relPath, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
      }

      for (const skill of config.skills) {
        const content = textManagedPayload(skill.frontmatter, skill.body);
        const relPath = `.opencode/skills/${skill.id}/SKILL.md`;
        outputs.push({ target: 'opencode', kind: 'skill', id: skill.id, source: skill.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'skill'), inventory: [{ version: 1, relPath, format: 'markdown', selector: '$' }], content, hash: sha256(content), isJson: false });
        for (const asset of skill.assets) {
          const relPath = skillAssetTargetPath('opencode', skill.id, asset);
          outputs.push({ target: 'opencode', kind: 'skill', id: skill.id, source: asset.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'skill'), inventory: [{ version: 1, relPath, format: 'file', selector: '$' }], sourceFile: asset.source.absPath, hash: asset.hash, isJson: false });
        }
      }

      if (config.mcps.length > 0) {
        const mcp = Object.fromEntries([...config.mcps].sort((a, b) => a.id.localeCompare(b.id)).map((server) => [
          server.id,
          server.transport.kind === 'local'
            ? { type: 'local', enabled: true, command: [server.transport.command, ...server.transport.args] }
            : { type: 'remote', enabled: true, url: server.transport.url }
        ]));
        const content = `${JSON.stringify({ mcp }, null, 2)}\n`;
        for (const server of config.mcps) {
          const relPath = '.opencode/opencode.json';
          outputs.push({ target: 'opencode', kind: 'mcp', id: server.id, source: server.source.relPath, relPath, manifestRelPath: vendorManifestRelPath('opencode', 'mcp'), inventory: [{ version: 1, relPath, format: 'json', selector: `$.mcp.${server.id}` }], content, hash: sha256(content), isJson: true });
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
