import { workflow, job, step, push } from '@kici-dev/sdk';

/**
 * Provision a repo-declared toolchain with mise via the generic init engine.
 *
 * The committed `mise.toml` pins `jq = "1.7.1"`. The init command installs mise
 * if absent, runs `mise install`, exports mise's env to `$KICI_ENV` and the shims
 * dir to `$KICI_PATH`, and caches mise's data dir so only the first run downloads.
 * The single step then runs `jq --version`, proving jq is on PATH for steps.
 */
export const miseInit = workflow('mise-init', {
  on: [push()],
  jobs: [
    job('build', {
      runsOn: 'linux',
      init: {
        run: `
          set -euo pipefail
          command -v mise >/dev/null || curl -fsSL https://mise.run | sh
          export PATH="$HOME/.local/bin:$PATH"
          mise install
          # Hand mise's non-PATH env to subsequent steps via the $KICI_ENV
          # contract. The parser takes each value verbatim after the first '=',
          # so strip mise's surrounding double-quotes; drop PATH (handled via
          # $KICI_PATH below). All-sed, single-quoted scripts keep the regex
          # literal and exit 0 even when PATH is the only line (a 'grep -v' here
          # would exit 1 under 'set -o pipefail' and abort the init).
          mise env -s bash | sed -n 's/^export //p' | sed '/^PATH=/d' | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/\\1=\\2/' >> "$KICI_ENV"
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
