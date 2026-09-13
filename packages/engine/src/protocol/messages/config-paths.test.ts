import { describe, it, expect } from 'vitest';
import { ConfigPathsSchema } from './config-paths.js';

describe('ConfigPathsSchema', () => {
  it('accepts an empty object — every field is optional', () => {
    expect(ConfigPathsSchema.parse({})).toEqual({});
  });

  it('round-trips all three paths', () => {
    const input = {
      envFile: '/etc/kici/kici-orchestrator.env',
      scalerConfig: '/etc/kici/scalers.yaml',
      composeFile: '/etc/kici/kici-orchestrator-compose.yaml',
    };
    expect(ConfigPathsSchema.parse(input)).toEqual(input);
  });

  it('rejects an empty-string path rather than reporting a path of ""', () => {
    expect(ConfigPathsSchema.safeParse({ envFile: '' }).success).toBe(false);
  });
});
