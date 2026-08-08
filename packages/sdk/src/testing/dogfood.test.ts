import { describe, it, expect, afterEach } from 'vitest';
import { createTestStepContext, type TestStepContext } from '@kici-dev/sdk/testing';
import type { StepContext } from '@kici-dev/sdk';

// A customer's step function under test — pure CI logic that shells out,
// reads a secret, sets an output env var, and emits a completion event. This
// test imports through the public package specifier exactly as a customer
// would, so it is the dogfood of the @kici-dev/sdk/testing subpath.
async function deployStep(ctx: StepContext): Promise<void> {
  const branch = (await ctx.$`echo main`).stdout.trim();
  const token = await ctx.secrets.get('DEPLOY_TOKEN');
  ctx.setEnv('DEPLOYED_BRANCH', branch);
  await ctx.emit('deploy-complete', { branch, tokenLen: token.length });
}

describe('unit-testing a step function with @kici-dev/sdk/testing', () => {
  let handle: TestStepContext | undefined;
  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
  });

  it('drives a real step function and asserts its side effects', async () => {
    handle = createTestStepContext({ secrets: { flat: { DEPLOY_TOKEN: 'sekret' } } });

    await deployStep(handle.ctx);

    expect(handle.ctx.env.DEPLOYED_BRANCH).toBe('main');
    expect(handle.emitCalls).toEqual([
      {
        eventName: 'deploy-complete',
        payload: { branch: 'main', tokenLen: 6 },
        options: undefined,
      },
    ]);
  });
});
