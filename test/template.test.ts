import { describe, expect, it } from 'vitest';

import { renderVendorTemplate } from '../src/core/template.js';

describe('renderVendorTemplate', () => {
  it('vendor.claude is true only when target is claude', () => {
    const tpl = "{% if vendor.claude %}A{% else %}B{% endif %}";
    expect(renderVendorTemplate(tpl, 'claude', 'test')).toBe('A');
    expect(renderVendorTemplate(tpl, 'codex', 'test')).toBe('B');
    expect(renderVendorTemplate(tpl, 'opencode', 'test')).toBe('B');
  });

  it('vendor.codex is true only when target is codex', () => {
    const tpl = "{% if vendor.codex %}A{% else %}B{% endif %}";
    expect(renderVendorTemplate(tpl, 'codex', 'test')).toBe('A');
    expect(renderVendorTemplate(tpl, 'claude', 'test')).toBe('B');
    expect(renderVendorTemplate(tpl, 'opencode', 'test')).toBe('B');
  });

  it('vendor.opencode is true only when target is opencode', () => {
    const tpl = "{% if vendor.opencode %}A{% else %}B{% endif %}";
    expect(renderVendorTemplate(tpl, 'opencode', 'test')).toBe('A');
    expect(renderVendorTemplate(tpl, 'claude', 'test')).toBe('B');
    expect(renderVendorTemplate(tpl, 'codex', 'test')).toBe('B');
  });

  it('nested if/elsif/else picks the right branch for each target', () => {
    const tpl = "{% if vendor.codex %}Codex{% elsif vendor.claude %}Claude{% else %}Other{% endif %}";
    expect(renderVendorTemplate(tpl, 'codex', 'test')).toBe('Codex');
    expect(renderVendorTemplate(tpl, 'claude', 'test')).toBe('Claude');
    expect(renderVendorTemplate(tpl, 'opencode', 'test')).toBe('Other');
  });

  it('unknown vendor variable throws with contextLabel in message', () => {
    const tpl = "{{ vendor.cursor }}";
    expect(() => renderVendorTemplate(tpl, 'claude', 'myLabel')).toThrow('myLabel');
  });

  it('include tag throws with contextLabel and includes/partials message', () => {
    const tpl = "{% include 'x' %}";
    expect(() => renderVendorTemplate(tpl, 'claude', 'myCtx')).toThrow('myCtx');
    expect(() => renderVendorTemplate(tpl, 'claude', 'myCtx')).toThrow('includes/partials are not supported');
  });

  it('render tag throws with contextLabel and includes/partials message', () => {
    const tpl = "{% render 'x' %}";
    expect(() => renderVendorTemplate(tpl, 'claude', 'myCtx')).toThrow('myCtx');
    expect(() => renderVendorTemplate(tpl, 'claude', 'myCtx')).toThrow('includes/partials are not supported');
  });

  it('whitespace-control include tag throws with contextLabel and includes/partials message', () => {
    const tpl = "{%- include 'x' -%}";
    expect(() => renderVendorTemplate(tpl, 'claude', 'myCtx')).toThrow('myCtx');
    expect(() => renderVendorTemplate(tpl, 'claude', 'myCtx')).toThrow('includes/partials are not supported');
  });

  it('malformed liquid throws with contextLabel in message', () => {
    const tpl = '{% if';
    expect(() => renderVendorTemplate(tpl, 'claude', 'badTpl')).toThrow('badTpl');
  });

  it('renders an empty conditional body for non-matching vendor flag', () => {
    expect(renderVendorTemplate('{% if vendor.codex %}X{% endif %}', 'claude', 'agents/x')).toBe('');
  });

  it('plain non-template content renders verbatim', () => {
    const tpl = 'just text';
    expect(renderVendorTemplate(tpl, 'claude', 'test')).toBe('just text');
  });
});
