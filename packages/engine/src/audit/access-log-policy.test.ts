import { describe, expect, it } from 'vitest';
import { AccessLogAction } from '../protocol/messages/access-log.js';
import {
  POLICY_BY_ACTION,
  fnv1a32,
  shouldRecordAccess,
  shouldRecordSecretResolve,
  type AccessLogRateLimiter,
} from './access-log-policy.js';
import type { ActorPrincipal } from '../protocol/messages/actor.js';

const userActor: ActorPrincipal = { type: 'user', sub: 'user-1' };
const operatorActor: ActorPrincipal = {
  type: 'platform_operator',
  sub: 'op-1',
  reason: 'incident XYZ-12345',
};

class AlwaysAllowLimiter implements AccessLogRateLimiter {
  permit(): boolean {
    return true;
  }
}

class NeverAllowLimiter implements AccessLogRateLimiter {
  permit(): boolean {
    return false;
  }
}

class SimpleTokenBucket implements AccessLogRateLimiter {
  private last = new Map<string, number>();
  private now: number;

  constructor(now: number) {
    this.now = now;
  }

  setNow(now: number): void {
    this.now = now;
  }

  permit(action: AccessLogAction, actorKey: string, perMinute: number): boolean {
    const key = `${action}:${actorKey}`;
    const intervalMs = Math.floor(60_000 / perMinute);
    const last = this.last.get(key);
    if (last !== undefined && this.now - last < intervalMs) return false;
    this.last.set(key, this.now);
    return true;
  }
}

describe('POLICY_BY_ACTION', () => {
  it('is exhaustive over AccessLogAction.options', () => {
    for (const action of AccessLogAction.options) {
      expect(POLICY_BY_ACTION[action]).toBeDefined();
    }
  });
});

describe('fnv1a32', () => {
  it('returns the FNV-1a offset basis for empty input', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
  });

  it('produces stable hashes for the same input', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
  });

  it('produces different hashes for different inputs', () => {
    expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
  });
});

describe('shouldRecordAccess — overrides', () => {
  const limiter = new AlwaysAllowLimiter();

  it('records denied outcomes regardless of policy', () => {
    expect(shouldRecordAccess('diagnostics.read', 'denied', userActor, 'req-1', limiter)).toBe(
      true,
    );
    expect(shouldRecordAccess('run.detail.read', 'denied', userActor, 'req-1', limiter)).toBe(true);
  });

  it('records error outcomes regardless of policy', () => {
    expect(shouldRecordAccess('run.detail.read', 'error', userActor, 'req-1', limiter)).toBe(true);
  });

  it('records platform_operator activity regardless of policy', () => {
    // Run-detail is sampled at 5% — operator override forces full fidelity.
    for (let i = 0; i < 100; i++) {
      expect(
        shouldRecordAccess('run.detail.read', 'allowed', operatorActor, `req-${i}`, limiter),
      ).toBe(true);
    }
  });

  it('records platform_operator activity even for rate-limited actions', () => {
    const blocking = new NeverAllowLimiter();
    expect(
      shouldRecordAccess('diagnostics.read', 'allowed', operatorActor, 'req-1', blocking),
    ).toBe(true);
  });
});

describe('shouldRecordAccess — always actions', () => {
  it('always records', () => {
    const limiter = new AlwaysAllowLimiter();
    for (let i = 0; i < 50; i++) {
      expect(shouldRecordAccess('secret.reveal', 'allowed', userActor, `req-${i}`, limiter)).toBe(
        true,
      );
    }
  });
});

describe('shouldRecordAccess — sample actions', () => {
  it('produces a stable yes/no for the same actor + requestId', () => {
    const limiter = new AlwaysAllowLimiter();
    const a = shouldRecordAccess('run.detail.read', 'allowed', userActor, 'req-42', limiter);
    const b = shouldRecordAccess('run.detail.read', 'allowed', userActor, 'req-42', limiter);
    expect(a).toBe(b);
  });

  it('approximates the configured rate over a large sample', () => {
    const limiter = new AlwaysAllowLimiter();
    let kept = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const actor: ActorPrincipal = { type: 'user', sub: `u-${i}` };
      if (shouldRecordAccess('run.detail.read', 'allowed', actor, `req-${i}`, limiter)) {
        kept++;
      }
    }
    // Target 5% = 500. Allow ±100 (well within 3σ for a binomial of n=10000, p=0.05, σ ≈ 22).
    expect(kept).toBeGreaterThan(400);
    expect(kept).toBeLessThan(600);
  });
});

describe('shouldRecordAccess — rate_limit actions', () => {
  it('permits the first call and denies subsequent calls within the window', () => {
    const bucket = new SimpleTokenBucket(0);
    const first = shouldRecordAccess('diagnostics.read', 'allowed', userActor, 'req-1', bucket);
    const second = shouldRecordAccess('diagnostics.read', 'allowed', userActor, 'req-2', bucket);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('permits again after the window elapses', () => {
    const bucket = new SimpleTokenBucket(0);
    expect(shouldRecordAccess('diagnostics.read', 'allowed', userActor, 'req-1', bucket)).toBe(
      true,
    );
    bucket.setNow(60_001);
    expect(shouldRecordAccess('diagnostics.read', 'allowed', userActor, 'req-2', bucket)).toBe(
      true,
    );
  });

  it('denied diagnostics.read bypasses the rate limit', () => {
    const blocking = new NeverAllowLimiter();
    expect(shouldRecordAccess('diagnostics.read', 'denied', userActor, 'req-1', blocking)).toBe(
      true,
    );
  });
});

describe('shouldRecordSecretResolve', () => {
  it('always records denied resolves', () => {
    expect(
      shouldRecordSecretResolve({
        outcome: 'denied',
        runId: 'run-1',
        jobId: 'job-1',
        userId: null,
        role: null,
      }),
    ).toBe(true);
  });

  it('approximates 1% on allowed resolves', () => {
    let kept = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      if (
        shouldRecordSecretResolve({
          outcome: 'allowed',
          runId: `run-${i}`,
          jobId: `job-${i}`,
          userId: null,
          role: null,
        })
      ) {
        kept++;
      }
    }
    // Target 1% = 100. Allow ±50 (3σ for n=10000, p=0.01 is ~30 — give margin).
    expect(kept).toBeGreaterThan(50);
    expect(kept).toBeLessThan(150);
  });

  it('produces stable yes/no for the same job', () => {
    const a = shouldRecordSecretResolve({
      outcome: 'allowed',
      runId: 'run-42',
      jobId: 'job-42',
      userId: null,
      role: null,
    });
    const b = shouldRecordSecretResolve({
      outcome: 'allowed',
      runId: 'run-42',
      jobId: 'job-42',
      userId: null,
      role: null,
    });
    expect(a).toBe(b);
  });
});
