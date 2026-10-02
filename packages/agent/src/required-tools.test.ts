import { describe, it, expect } from 'vitest';
import { agentToolRequirements } from './required-tools.js';

const names = (platform: NodeJS.Platform): string[] =>
  agentToolRequirements(platform).map((r) => ('name' in r ? r.name : r.type));

describe('agentToolRequirements', () => {
  it.each(['linux', 'darwin'] as const)('requires git and bash on %s', (platform) => {
    // breaks-if-wrong: a Linux or macOS agent starts without the shell its steps run in
    expect(names(platform)).toEqual(['git', 'bash']);
  });

  it('requires only git on Windows, where steps run in pwsh', () => {
    // fails-when: bash stays required on win32 — an agent on a host with Git's
    // `cmd` folder alone on PATH (the Git for Windows default) refuses to start.
    expect(names('win32')).toEqual(['git']);
  });
});
