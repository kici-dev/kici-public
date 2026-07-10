import { describe, it, expect } from 'vitest';
import { renderRunBanner } from './run-banner.js';

describe('renderRunBanner (offline)', () => {
  const banner = renderRunBanner({ mode: 'offline', planeUrl: 'http://127.0.0.1:4319' });

  it('states the independent/offline plane + bare-metal agent', () => {
    expect(banner).toContain('local dev orchestrator (independent, offline)');
    expect(banner).toContain('this machine (bare-metal)');
  });

  it('states the LOCAL secret source and the dev-signed identity', () => {
    expect(banner).toContain('secrets:  LOCAL files (.kici/.secrets, .env.local, --env)');
    expect(banner).toContain('identity: DEV-SIGNED (iss=kici-local — NOT prod)');
  });

  it('surfaces the control commands with the plane URL and the force flags', () => {
    expect(banner).toContain('kici local status | logs | down   (http://127.0.0.1:4319)');
    expect(banner).toContain('--connected (attach to Platform) · --in-place (ambient)');
  });

  it('is a closed box (top + bottom borders line up)', () => {
    const lines = banner.split('\n');
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });
});

describe('renderRunBanner (attached)', () => {
  const banner = renderRunBanner({
    mode: 'attached',
    planeUrl: 'http://127.0.0.1:4319',
    orgId: 'kiciStg00001',
  });

  it('states the hybrid/attached plane and REAL Platform identity', () => {
    expect(banner).toContain('local dev orchestrator (hybrid, attached)');
    expect(banner).toContain('REAL scoped (org: kiciStg00001)');
    expect(banner).toContain('real Platform OIDC + attestation');
  });

  it('titles the connected run and offers --offline as the force flag', () => {
    expect(banner).toContain('kici run --local (connected)');
    expect(banner).toContain('--offline (local plane) · --in-place (ambient)');
  });
});

describe('renderRunBanner (fallback)', () => {
  const banner = renderRunBanner({
    mode: 'fallback',
    planeUrl: 'http://127.0.0.1:4319',
    fallbackReason: 'Platform unreachable',
  });

  it('leads with a LOUD Platform-unreachable line then the offline body', () => {
    expect(banner).toContain('⚠');
    expect(banner).toContain('fell back to OFFLINE');
    expect(banner).toContain('local dev orchestrator (independent, offline)');
    expect(banner).toContain('DEV-SIGNED (iss=kici-local — NOT prod)');
  });
});

describe('renderRunBanner (trusted)', () => {
  it('adds a loud TRUSTED execution line when trusted', () => {
    const banner = renderRunBanner({
      mode: 'offline',
      planeUrl: 'http://127.0.0.1:4319',
      trusted: true,
    });
    expect(banner).toContain('TRUSTED — host env passthrough (NOT sandboxed)');
  });

  it('omits the TRUSTED line for a normal (sandboxed) run', () => {
    const banner = renderRunBanner({ mode: 'offline', planeUrl: 'http://127.0.0.1:4319' });
    expect(banner).not.toContain('TRUSTED');
  });
});
