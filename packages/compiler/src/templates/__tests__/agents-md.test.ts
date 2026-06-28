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

  it('covers the canonical anti-patterns', () => {
    expect(agentsMdTemplate).toContain('Do NOT write `.yml` / `.yaml`');
    expect(agentsMdTemplate).toContain('/dist/');
    expect(agentsMdTemplate).toContain('`await` outside step bodies');
  });

  it('documents the local command loop', () => {
    expect(agentsMdTemplate).toContain('kici compile --check');
    expect(agentsMdTemplate).toContain('kici run local');
    expect(agentsMdTemplate).toContain('kici preview');
  });

  it('includes runnable examples for push and PR matrix triggers', () => {
    expect(agentsMdTemplate).toContain("from '@kici-dev/sdk'");
    expect(agentsMdTemplate).toContain('push({');
    expect(agentsMdTemplate).toContain('pr({ target:');
    expect(agentsMdTemplate).toContain('matrix({');
  });
});
