import { RAC_MARKER, FM_SENSITIVE_MARKER } from '../core/util.js';

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
  return `---\n${toYaml(frontmatter)}\n---\n${FM_SENSITIVE_MARKER}\n${RAC_MARKER}\n\n${body}`;
}
