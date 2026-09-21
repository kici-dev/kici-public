import { describe, it, expectTypeOf } from 'vitest';
import type { AgentCloudInitCredentials, ClaimCodeCredentials } from './agent-cloud-init.js';

describe('AgentCloudInitCredentials', () => {
  // fails-when: the agent-token credentials form is accepted again
  it('rejects the removed agent-token credentials form', () => {
    const bad: AgentCloudInitCredentials = {
      // @ts-expect-error — the token form is no longer a credential shape
      agentToken: 't',
      agentId: 'a',
      orchestratorUrl: 'u',
      labels: [],
    };
    expectTypeOf(bad).toBeObject();
  });

  // breaks-if-wrong: the claim-code form must still be the accepted shape
  it('is exactly the claim-code form', () => {
    expectTypeOf<AgentCloudInitCredentials>().toEqualTypeOf<ClaimCodeCredentials>();
  });
});
