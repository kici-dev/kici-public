import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Provision a repo-declared toolchain with the zero-config mise preset.
 *
 * Where `mise-init.ts` spells out the full generic init command, this uses the
 * `init: 'mise'` preset: the agent expands it to the same install + env handoff
 * and caches mise's data dir under a key derived from the committed `mise.toml`.
 * The takeaway: presets remove the boilerplate while expanding to the identical
 * generic init the engine already runs.
 */
export const misePreset = workflow('mise-preset', {
  on: [push()],
  jobs: [
    job('build', {
      runsOn: 'linux',
      // 'mise' is the zero-config preset; { mise: { timeout, cache, env, shell } }
      // tunes the same fields a hand-written generic init exposes (minus run).
      init: 'mise',
      steps: [
        step('show-jq-version', async (ctx) => {
          // jq is on PATH because the mise preset appended the shims dir to $KICI_PATH.
          const { stdout } = await ctx.$`jq --version`;
          ctx.log.info(`jq version: ${stdout.trim()}`);
        }),
      ],
    }),
  ],
});
