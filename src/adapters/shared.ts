import { MANAGED_MARKDOWN_WARNING } from '../core/util.js';

function yamlEscape(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => yamlEscape(entry)).join(', ')}]`;
  return JSON.stringify(value);
}

function toYaml(frontmatter: Record<string, unknown>): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${yamlEscape(value)}`)
    .join('\n');
}

export function textManagedPayload(frontmatter: Record<string, unknown>, body: string): string {
  // Claude/Codex markdown parsers require YAML frontmatter at byte 0, so the RAC marker
  // must come immediately after the closing frontmatter delimiter (not before frontmatter).
  return `---\n${toYaml(frontmatter)}\n---\n${MANAGED_MARKDOWN_WARNING}\n${body}`;
}
