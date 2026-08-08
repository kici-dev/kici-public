import { describe, it, expect } from 'vitest';
import { AgentPlatform, splitAgentPlatform } from './agent-platform.js';

describe('AgentPlatform', () => {
  it('accepts the glibc-Linux bootstrap set', () => {
    expect(AgentPlatform.parse('linux-x64')).toBe('linux-x64');
    expect(AgentPlatform.parse('linux-arm64')).toBe('linux-arm64');
  });

  it('rejects unsupported platforms', () => {
    expect(() => AgentPlatform.parse('darwin-arm64')).toThrow();
    expect(() => AgentPlatform.parse('linux-musl')).toThrow();
  });

  it('splits x64 into node + npm parts', () => {
    expect(splitAgentPlatform('linux-x64')).toEqual({
      nodeOs: 'linux',
      nodeArch: 'x64',
      npmOs: 'linux',
      npmCpu: 'x64',
    });
  });

  it('splits arm64 into node + npm parts', () => {
    expect(splitAgentPlatform('linux-arm64')).toEqual({
      nodeOs: 'linux',
      nodeArch: 'arm64',
      npmOs: 'linux',
      npmCpu: 'arm64',
    });
  });
});
