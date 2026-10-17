import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_SUDO_GROUP_GID, buildAgentContainerHostConfig } from './container-hostconfig.js';

const AGENT_DOCKERFILE = readFileSync(
  new URL('../../../agent/Dockerfile', import.meta.url),
  'utf8',
);

describe('agent sudo group', () => {
  it('matches the group the agent image creates and grants sudo to', () => {
    // fails-when: the scaler adds a gid the image never created, so pool steps get no sudo
    const created = /groupadd --system --gid (\d+) kici-sudo/.exec(AGENT_DOCKERFILE);
    expect(created?.[1]).toBe(String(AGENT_SUDO_GROUP_GID));
    expect(AGENT_DOCKERFILE).toContain("printf '%%kici-sudo ALL=(ALL:ALL) NOPASSWD: ALL\\n'");
    expect(AGENT_DOCKERFILE).toContain('visudo -cf /etc/sudoers.d/kici-sudo');
  });

  it('adds supplementary groups only when asked', () => {
    expect(
      buildAgentContainerHostConfig({ supplementaryGroups: [AGENT_SUDO_GROUP_GID] }).GroupAdd,
    ).toEqual(['1990']);
    // breaks-if-wrong: a job-image or bare-metal container must get no extra group
    expect(buildAgentContainerHostConfig({}).GroupAdd).toBeUndefined();
    expect(buildAgentContainerHostConfig({ supplementaryGroups: [] }).GroupAdd).toBeUndefined();
  });
});
