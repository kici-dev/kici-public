import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModeAppDepsExtras, OrchestratorHooks } from './orchestrator-core.js';

/**
 * The dependencies a mode hook hands to `createApp()`. The hook's return type
 * does not check the keys of a returned literal, so `server.ts` and
 * `standalone.ts` mark theirs `satisfies ModeAppDepsExtras`. The literal below
 * is built the same way; `pnpm typecheck:tests` fails on an unused
 * `@ts-expect-error`, so each one must stay a type error.
 */
describe('mode hook appDepsExtras', () => {
  it('refuses a misspelled or mistyped createApp dependency at compile time', () => {
    const onSubsystemsReady: OrchestratorHooks['onSubsystemsReady'] = async () => {
      return {
        appDepsExtras: {
          // breaks-if-wrong: a correctly spelled dependency and the gate's
          //   matchContext stay accepted
          resolveGithubManifestCallbackUrl: () => null,
          matchContext: async () => null,
          // fails-when: the extras type is an untyped record again, so a typo
          //   reaches createApp unread
          // @ts-expect-error -- not an AppDependencies field (misspelled)
          resolveGithubManifestCallbakUrl: () => null,
        } satisfies ModeAppDepsExtras,
      };
    };
    const mistyped = {
      // @ts-expect-error -- the wrong type for an AppDependencies field
      heldRunStore: 'not a store',
    } satisfies ModeAppDepsExtras;
    expect(typeof onSubsystemsReady).toBe('function');
    expect(mistyped).toBeDefined();
  });

  it.each(['server.ts', 'standalone.ts'])('%s checks its extras literal', (file) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf-8');
    // fails-when: the satisfies clause is dropped and a typo in the literal compiles
    expect(source).toMatch(/appDepsExtras: \{[\s\S]*?\n\s*\} satisfies ModeAppDepsExtras,/);
  });
});
