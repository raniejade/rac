import { Liquid } from 'liquidjs';

import type { Target } from './types.js';

const TEMPLATE_ENGINE = new Liquid({
  strictVariables: true,
  strictFilters: true,
  dynamicPartials: false
});

function hasDisallowedPartialTag(node: unknown, seen = new Set<object>()): boolean {
  if (!node || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  const maybeToken = (node as { token?: { name?: unknown } }).token;
  if (maybeToken && (maybeToken.name === 'include' || maybeToken.name === 'render')) return true;

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (hasDisallowedPartialTag(item, seen)) return true;
      }
      continue;
    }
    if (value && typeof value === 'object' && hasDisallowedPartialTag(value, seen)) return true;
  }
  return false;
}

function containsDisallowedPartials(raw: string, parsed: unknown[]): boolean {
  if (parsed.some((node) => hasDisallowedPartialTag(node))) return true;
  return /{%-?\s*(include|render)\b/.test(raw);
}

function templateScope(target: Target): { vendor: { claude: boolean; codex: boolean; opencode: boolean } } {
  return {
    vendor: {
      claude: target === 'claude',
      codex: target === 'codex',
      opencode: target === 'opencode'
    }
  };
}

export function renderVendorTemplate(raw: string, target: Target, contextLabel: string): string {
  try {
    const parsed = TEMPLATE_ENGINE.parse(raw);
    if (containsDisallowedPartials(raw, parsed)) {
      throw new Error('includes/partials are not supported in templates');
    }
    return TEMPLATE_ENGINE.renderSync(parsed, templateScope(target));
  } catch (error) {
    throw new Error(`${contextLabel}: template render failed: ${String((error as Error).message || error)}`);
  }
}
