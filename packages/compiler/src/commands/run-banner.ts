/**
 * Always-on startup banner for `kici run --local`, so a developer always knows
 * which plane a run used and why.
 * - `offline`  — independent plane, local secrets, dev-signed identity.
 * - `attached` — hybrid plane, OIDC + attestation signed by the plane's own key.
 * - `fallback` — attached was wanted but the Platform was unreachable; a LOUD
 *   first line makes the degradation obvious.
 */

export type RunBannerMode = 'offline' | 'attached' | 'fallback';

export interface RunBannerInput {
  mode: RunBannerMode;
  planeUrl: string;
  /** Attached variant. */
  orgId?: string;
  /** Fallback variant. */
  fallbackReason?: string;
  /**
   * `--trusted`: the run routes to the trusted label set, so steps see the ambient
   * host env (minus the agent's own KiCI identity secrets); the banner says so loudly.
   */
  trusted?: boolean;
}

/** Plain (uncolored) boxed text. */
export function renderRunBanner(input: RunBannerInput): string {
  const title = input.mode === 'attached' ? 'kici run --local (connected)' : 'kici run --local';

  const rows: Array<[string, string]> = [];
  if (input.mode === 'fallback') {
    rows.push([
      '⚠',
      `Platform unreachable — fell back to OFFLINE${input.fallbackReason ? ` (${input.fallbackReason})` : ''}`,
    ]);
  }

  if (input.mode === 'attached') {
    rows.push(
      ['plane', 'local dev orchestrator (hybrid, attached)'],
      ['agent', 'this machine (bare-metal)'],
      ['secrets', `REAL scoped${input.orgId ? ` (org: ${input.orgId})` : ''}`],
      ['identity', `plane-signed OIDC + attestation (iss=${input.planeUrl})`],
      ['control', `kici local status | logs | detach   (${input.planeUrl})`],
      ['force', '--offline (local plane) · --in-place (ambient)'],
    );
  } else {
    rows.push(
      ['plane', 'local dev orchestrator (independent, offline)'],
      ['agent', 'this machine (bare-metal)'],
      ['secrets', 'LOCAL files (.kici/.secrets, .env.local, --env)'],
      ['identity', 'DEV-SIGNED (iss=kici-local — NOT prod)'],
      ['control', `kici local status | logs | down   (${input.planeUrl})`],
      ['force', '--connected (attach to Platform) · --in-place (ambient)'],
    );
  }

  if (input.trusted) {
    rows.push(['execution', 'TRUSTED — host env passthrough (NOT sandboxed)']);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const bodyLines = rows.map(
    ([label, value]) => `${(label + ':').padEnd(labelWidth + 1)} ${value}`,
  );
  const contentWidth = Math.max(title.length + 2, ...bodyLines.map((l) => l.length));

  const top = `┌ ${title} ${'─'.repeat(Math.max(0, contentWidth - title.length))}┐`;
  const bottom = `└${'─'.repeat(contentWidth + 2)}┘`;
  const boxed = bodyLines.map((l) => `│ ${l.padEnd(contentWidth)} │`);
  return [top, ...boxed, bottom].join('\n');
}
