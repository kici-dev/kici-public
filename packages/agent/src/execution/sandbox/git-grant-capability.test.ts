import { describe, expect, it } from 'vitest';
import { withAgentSshCapability } from './git-grant-capability.js';
import type { GitGrantRequestIpc } from './ipc-protocol.js';

const elevate = (sshCapable?: boolean): GitGrantRequestIpc => ({
  type: 'git.grant.request',
  requestId: 'r1',
  op: 'elevate',
  repository: 'acme/app',
  ...(sshCapable === undefined ? {} : { sshCapable }),
});

describe('withAgentSshCapability', () => {
  // fails-when: the relay trusts the runner's claim — a container runner that
  // says sshCapable would get a key written for it.
  it("ignores a runner's claim when its git cannot read the agent's files", () => {
    expect(withAgentSshCapability(elevate(true), false).sshCapable).toBe(false);
  });

  // breaks-if-wrong: a bare-metal job with the helper must still get its key.
  it('keeps the claim for a host-path runner', () => {
    expect(withAgentSshCapability(elevate(true), true).sshCapable).toBe(true);
  });

  it('never grants a capability the runner did not ask for', () => {
    expect(withAgentSshCapability(elevate(), true).sshCapable).toBe(false);
  });

  it('leaves the rest of the request untouched', () => {
    expect(withAgentSshCapability(elevate(true), true)).toMatchObject({
      requestId: 'r1',
      op: 'elevate',
      repository: 'acme/app',
    });
  });
});
