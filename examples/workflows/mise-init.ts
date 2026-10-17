import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Provision a repo-declared toolchain with mise via the generic init engine.
 *
 * The committed `mise.toml` pins `jq = "1.7.1"`. The init command installs mise
 * if absent, trusts the committed config, runs `mise install`, exports mise's env to `$KICI_ENV` and the shims
 * dir to `$KICI_PATH`, and caches mise's data dir so only the first run downloads.
 * The single step then runs `jq --version`, proving jq is on PATH for steps.
 */
export const miseInit = workflow('mise-init', {
  on: [push()],
  jobs: [
    job('build', {
      runsOn: 'kici:os:linux',
      init: {
        run: `
          set -euo pipefail
          command -v mise >/dev/null || curl -fsSL https://mise.run | sh
          export PATH="$HOME/.local/bin:$PATH"
          # mise reads a committed config only after it is trusted.
          mise trust
          mise install
          # Hand mise's non-PATH env to subsequent steps via the $KICI_ENV
          # contract. The parser takes each value verbatim after the first '=',
          # and 'mise env --dotenv' prints plain KEY=value lines with no shell
          # quoting. Drop PATH (handled via $KICI_PATH below); sed exits 0 even
          # when PATH is the only line, where 'grep -v' would exit 1 under
          # 'set -o pipefail' and abort the init.
          mise env --dotenv | sed '/^PATH=/d' >> "$KICI_ENV"
          echo "$HOME/.local/share/mise/shims" >> "$KICI_PATH"
        `,
        cache: { key: 'mise-jq-1.7.1', paths: ['~/.local/share/mise'] },
        timeout: 600_000,
      },
      steps: [
        step('show-jq-version', async (ctx) => {
          // jq is on PATH because the init phase appended the mise shims dir to $KICI_PATH.
          const { stdout } = await ctx.$`jq --version`;
          ctx.log.info(`jq version: ${stdout.trim()}`);
        }),
      ],
    }),
  ],
});
