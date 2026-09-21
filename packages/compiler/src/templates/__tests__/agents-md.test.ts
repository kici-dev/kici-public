import { describe, it, expect } from 'vitest';
import { agentsMdTemplate } from '../agents-md.js';

describe('agents-md template', () => {
  it('starts with a level-1 heading naming KiCI', () => {
    expect(agentsMdTemplate.startsWith('# KiCI')).toBe(true);
  });

  it('points at the local SDK type declarations', () => {
    expect(agentsMdTemplate).toContain('node_modules/@kici-dev/sdk/dist/index.d.ts');
  });

  it('lists the offline + online LLM context surfaces', () => {
    expect(agentsMdTemplate).toContain('kici docs llm');
    expect(agentsMdTemplate).toContain('https://kici.dev/llms.txt');
    expect(agentsMdTemplate).toContain('https://kici.dev/llms-full.txt');
  });

  it('names only kici docs llm forms the CLI accepts', () => {
    // fails-when: a flag form returns (`kici docs llm --index` shipped in the
    // scaffold while no such flag existed) or a topic the bundle set lacks.
    const forms = [...agentsMdTemplate.matchAll(/kici docs llm(?: ([a-z-]+))?/g)].map(
      (m) => m[1] ?? '',
    );
    expect(forms.length).toBeGreaterThan(0);
    for (const arg of forms) expect(['', 'full', 'sdk'], arg).toContain(arg);
    // breaks-if-wrong: the index, the full bundle and a task bundle are each
    // named once, so a reader learns all three entry points.
    expect(new Set(forms)).toEqual(new Set(['', 'full', 'sdk']));
  });

  it('covers the canonical anti-patterns', () => {
    expect(agentsMdTemplate).toContain('Do NOT write `.yml` / `.yaml`');
    expect(agentsMdTemplate).toContain('/dist/');
    expect(agentsMdTemplate).toContain('`await` outside step bodies');
  });

  it('documents the local command loop', () => {
    expect(agentsMdTemplate).toContain('kici compile --check');
    expect(agentsMdTemplate).toContain('kici run push --local');
    expect(agentsMdTemplate).toContain('kici preview');
  });

  it('includes runnable examples for push and PR matrix triggers', () => {
    expect(agentsMdTemplate).toContain("from '@kici-dev/sdk'");
    expect(agentsMdTemplate).toContain('push({');
    expect(agentsMdTemplate).toContain('pr({ target:');
    // The matrix is a direct job option, not GitHub Actions' strategy wrapper.
    expect(agentsMdTemplate).toContain('matrix: {');
  });

  it('does not teach any nonexistent SDK API shapes', () => {
    // `matrix` is not a factory export; there is no `strategy` job field.
    expect(agentsMdTemplate).not.toContain('matrix(');
    expect(agentsMdTemplate).not.toContain('strategy:');
    // Secrets are read via the get/expose accessor, not dotted context access.
    expect(agentsMdTemplate).not.toContain('secrets.production');
  });
});
