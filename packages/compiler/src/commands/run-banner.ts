/**
 * Always-on startup banner for a routed `kici run --local` invocation. States
 * the selected plane, where the agent runs, the secret + identity source, the
 * control commands, and the flags that force a different behavior — so a
 * developer always knows which plane a run used and why (design §5).
 *
 * Three variants:
 * - `offline`  — independent plane, local secrets, dev-signed identity.
 * - `attached` — hybrid plane, real Platform-minted OIDC + attestation.
 * - `fallback` — wanted attached but the Platform was unreachable, so the run
 *   fell back to offline; a LOUD first line makes the degradation obvious.
 */

export type RunBannerMode = 'offline' | 'attached' | 'fallback';

export interface RunBannerInput {
  mode: RunBannerMode;
  /** Plane orchestrator URL (surfaced on the control line). */
  planeUrl: string;
  /** Org id (attached variant). */
  orgId?: string;
  /** Why the run fell back to offline (fallback variant). */
  fallbackReason?: string;
  /**
   * Trusted fleet-agent profile (`--trusted`): the run routes to the trusted
   * label set, so steps see the ambient host env (minus the agent's own KiCI
   * identity secrets). Surfaced as a loud line so a trusted run is never silent.
   */
  trusted?: boolean;
}

/** Render the boxed run banner as a plain (uncolored) multi-line string. */
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
      ['identity', 'real Platform OIDC + attestation'],
      ['control', `kici local status | logs | detach   (${input.planeUrl})`],
      ['force', '--offline (local plane) · --in-place (ambient)'],
    );
  } else {
    // offline + fallback share the same body.
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
