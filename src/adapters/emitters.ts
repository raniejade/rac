import path from 'node:path';
import type { AgentDef, McpDef, Scope, SkillDef, Target } from '../core/types.js';
import { AIRC_MARKER, FM_SENSITIVE_MARKER } from '../core/util.js';

function yamlEscape(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => yamlEscape(entry)).join(', ')}]`;
  }
  return JSON.stringify(value);
}

function toYaml(frontmatter: Record<string, unknown>): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${yamlEscape(value)}`)
    .join('\n');
}

function stripVendorBlock(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const { vendor: _dropVendor, ...rest } = frontmatter;
  return rest;
}

function textManagedPayload(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${toYaml(frontmatter)}\n---\n${FM_SENSITIVE_MARKER}\n${AIRC_MARKER}\n\n${body}`;
}

export function emitAgent(target: Target, agent: AgentDef): { relPath: string; content: string; isJson: boolean } {
  const body = agent.instructions;
  const frontmatter = {
    name: agent.id,
    description: agent.description ?? agent.name ?? agent.id
  };

  if (target === 'claude') {
    return {
      relPath: `.claude/agents/${agent.id}.md`,
      content: textManagedPayload(frontmatter, body),
      isJson: false
    };
  }
  if (target === 'opencode') {
    return {
      relPath: `.opencode/agents/${agent.id}.md`,
      content: textManagedPayload(frontmatter, body),
      isJson: false
    };
  }

  const emitMode = (agent.vendor?.codex as { emit?: string } | undefined)?.emit;
  if (emitMode === 'instruction-only') {
    return {
      relPath: `.codex/agents/${agent.id}.md`,
      content: textManagedPayload(frontmatter, body),
      isJson: false
    };
  }

  const toml = `${AIRC_MARKER}\nid = ${JSON.stringify(agent.id)}\ninstructions = ${JSON.stringify(body)}\n`;
  return {
    relPath: `.codex/agents/${agent.id}.toml`,
    content: toml,
    isJson: false
  };
}

export function emitSkill(target: Target, skill: SkillDef): { relPath: string; content: string; isJson: boolean } {
  const vendor = skill.frontmatter.vendor as { claude?: { frontmatter?: Record<string, unknown> } } | undefined;

  let frontmatter = stripVendorBlock({
    ...skill.frontmatter,
    name: skill.id,
    description: skill.description
  });

  if (target === 'claude' && vendor?.claude?.frontmatter) {
    frontmatter = vendor.claude.frontmatter;
  }

  const content = textManagedPayload(frontmatter, skill.body);

  if (target === 'claude') return { relPath: `.claude/skills/${skill.id}/SKILL.md`, content, isJson: false };
  if (target === 'codex') return { relPath: `.agents/skills/${skill.id}/SKILL.md`, content, isJson: false };
  return { relPath: `.opencode/skills/${skill.id}/SKILL.md`, content, isJson: false };
}

export function emitMcp(target: Target, mcp: McpDef, scope: Scope): { relPath: string; content: string; isJson: boolean } {
  if (target === 'claude') {
    const relPath = scope === 'project' ? '.mcp.json' : '.claude.json';
    const payload = {
      mcpServers: {
        [mcp.id]: mcp.command
          ? { command: mcp.command, args: mcp.args ?? [] }
          : { type: mcp.type, url: mcp.url }
      }
    };
    return { relPath, content: `${JSON.stringify(payload, null, 2)}\n`, isJson: true };
  }

  if (target === 'codex') {
    const timeoutSec = mcp.startup_timeout_ms ? Math.ceil(mcp.startup_timeout_ms / 1000) : undefined;
    const lines = [`${AIRC_MARKER}`, `[mcp_servers.${mcp.id}]`];
    if (mcp.command) {
      lines.push(`command = ${JSON.stringify(mcp.command)}`);
      lines.push(`args = [${(mcp.args ?? []).map((v) => JSON.stringify(v)).join(', ')}]`);
    } else {
      lines.push(`type = ${JSON.stringify(mcp.type)}`);
      lines.push(`url = ${JSON.stringify(mcp.url)}`);
    }
    if (timeoutSec) lines.push(`startup_timeout = ${timeoutSec}`);
    return { relPath: '.codex/config.toml', content: `${lines.join('\n')}\n`, isJson: false };
  }

  const payload = {
    mcp: {
      [mcp.id]: mcp.command
        ? { command: [mcp.command, ...(mcp.args ?? [])] }
        : { type: 'remote', url: mcp.url }
    }
  };

  return { relPath: '.opencode/opencode.json', content: `${JSON.stringify(payload, null, 2)}\n`, isJson: true };
}

export function emitMcps(target: Target, mcps: McpDef[], scope: Scope): { relPath: string; content: string; isJson: boolean } {
  const sortedMcps = [...mcps].sort((a, b) => a.id.localeCompare(b.id));

  if (target === 'claude') {
    const relPath = scope === 'project' ? '.mcp.json' : '.claude.json';
    const mcpServers = Object.fromEntries(sortedMcps.map((mcp) => [
      mcp.id,
      mcp.command
        ? { command: mcp.command, args: mcp.args ?? [] }
        : { type: mcp.type, url: mcp.url }
    ]));
    return { relPath, content: `${JSON.stringify({ mcpServers }, null, 2)}\n`, isJson: true };
  }

  if (target === 'codex') {
    const lines = [AIRC_MARKER];
    for (const mcp of sortedMcps) {
      const timeoutSec = mcp.startup_timeout_ms ? Math.ceil(mcp.startup_timeout_ms / 1000) : undefined;
      lines.push(`[mcp_servers.${mcp.id}]`);
      if (mcp.command) {
        lines.push(`command = ${JSON.stringify(mcp.command)}`);
        lines.push(`args = [${(mcp.args ?? []).map((v) => JSON.stringify(v)).join(', ')}]`);
      } else {
        lines.push(`type = ${JSON.stringify(mcp.type)}`);
        lines.push(`url = ${JSON.stringify(mcp.url)}`);
      }
      if (timeoutSec) lines.push(`startup_timeout = ${timeoutSec}`);
      lines.push('');
    }
    return { relPath: '.codex/config.toml', content: `${lines.join('\n').trimEnd()}\n`, isJson: false };
  }

  const mcpPayload = Object.fromEntries(sortedMcps.map((mcp) => [
    mcp.id,
    mcp.command
      ? { command: [mcp.command, ...(mcp.args ?? [])] }
      : { type: 'remote', url: mcp.url }
  ]));
  return { relPath: '.opencode/opencode.json', content: `${JSON.stringify({ mcp: mcpPayload }, null, 2)}\n`, isJson: true };
}

export function skillAssetTargetPath(target: Target, skillId: string, assetRelativePath: string): string {
  if (target === 'claude') return path.join('.claude/skills', skillId, assetRelativePath);
  if (target === 'codex') return path.join('.agents/skills', skillId, assetRelativePath);
  return path.join('.opencode/skills', skillId, assetRelativePath);
}
