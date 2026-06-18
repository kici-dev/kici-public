import { describe, it, expect } from 'vitest';
import {
  ACCESS_LOG_COLD_DAYS,
  ACCESS_LOG_WARM_DAYS,
  accessLogWarmSqlCase,
  auditLogColdDays,
  auditLogWarmDays,
  auditLogWarmSqlCase,
  getAccessLogColdDays,
  getAccessLogWarmDays,
  getAuditLogColdDays,
  getAuditLogWarmDays,
  getSecretAuditLogColdDays,
  getSecretAuditLogWarmDays,
  minAccessLogWarmDays,
  minAuditLogWarmDays,
  minSecretAuditLogWarmDays,
  secretAuditLogColdDays,
  secretAuditLogWarmDays,
  secretAuditLogWarmSqlCase,
} from './retention-policy.js';
import { AccessLogAction } from '../protocol/messages/access-log.js';

describe('retention-policy — access_log', () => {
  it('ACCESS_LOG_WARM_DAYS is exhaustive over AccessLogAction.options', () => {
    const mapped = new Set(Object.keys(ACCESS_LOG_WARM_DAYS));
    for (const action of AccessLogAction.options) {
      expect(mapped.has(action)).toBe(true);
    }
    expect(mapped.size).toBe(AccessLogAction.options.length);
  });

  it('every action key matches the safe-SQL shape', () => {
    for (const action of AccessLogAction.options) {
      expect(action).toMatch(/^[a-z0-9_.-]+$/);
    }
  });

  it('per-action lookup returns the mapped value for allowed/user', () => {
    for (const action of AccessLogAction.options) {
      expect(getAccessLogWarmDays({ action, outcome: 'allowed', actorType: 'user' })).toBe(
        ACCESS_LOG_WARM_DAYS[action],
      );
    }
  });

  it('outcome=denied promotes any action to 180d (forensic override)', () => {
    expect(
      getAccessLogWarmDays({ action: 'run.detail.read', outcome: 'denied', actorType: 'user' }),
    ).toBe(180);
    expect(
      getAccessLogWarmDays({ action: 'secret.set', outcome: 'denied', actorType: 'user' }),
    ).toBe(180);
    expect(
      getAccessLogWarmDays({ action: 'diagnostics.read', outcome: 'denied', actorType: 'user' }),
    ).toBe(180);
  });

  it('outcome=error also promotes to 180d', () => {
    expect(
      getAccessLogWarmDays({ action: 'run.detail.read', outcome: 'error', actorType: 'user' }),
    ).toBe(180);
  });

  it('actorType=platform_operator promotes any action to 365d', () => {
    expect(
      getAccessLogWarmDays({
        action: 'run.detail.read',
        outcome: 'allowed',
        actorType: 'platform_operator',
      }),
    ).toBe(365);
    expect(
      getAccessLogWarmDays({
        action: 'diagnostics.read',
        outcome: 'allowed',
        actorType: 'platform_operator',
      }),
    ).toBe(365);
  });

  it('outcome override wins over platform_operator override', () => {
    // Both apply: outcome=denied (180d) should beat platform_operator (365d)
    // because the outcome override is "more conservative for forensics"
    // — this matches the policy file's order of precedence.
    expect(
      getAccessLogWarmDays({
        action: 'run.detail.read',
        outcome: 'denied',
        actorType: 'platform_operator',
      }),
    ).toBe(180);
  });

  it('high-volume sampled reads land in 30d bucket', () => {
    expect(ACCESS_LOG_WARM_DAYS['run.detail.read']).toBe(30);
    expect(ACCESS_LOG_WARM_DAYS['run.orch_logs.read']).toBe(30);
    expect(ACCESS_LOG_WARM_DAYS['step.logs.read']).toBe(30);
    expect(ACCESS_LOG_WARM_DAYS['environment.list.read']).toBe(30);
  });

  it('internal-ops reads land in 30d bucket', () => {
    expect(ACCESS_LOG_WARM_DAYS['diagnostics.read']).toBe(30);
    expect(ACCESS_LOG_WARM_DAYS['scaler.capacity.read']).toBe(30);
    expect(ACCESS_LOG_WARM_DAYS['scaler.agents.read']).toBe(30);
  });

  it('sensitive reads + tenant mutations land in 180d bucket', () => {
    expect(ACCESS_LOG_WARM_DAYS['run.payload.read']).toBe(180);
    expect(ACCESS_LOG_WARM_DAYS['env_var.list.read']).toBe(180);
    expect(ACCESS_LOG_WARM_DAYS['secret.list.read']).toBe(180);
    expect(ACCESS_LOG_WARM_DAYS['environment.create']).toBe(180);
    expect(ACCESS_LOG_WARM_DAYS['run.cancel']).toBe(180);
    expect(ACCESS_LOG_WARM_DAYS['backend.sync']).toBe(180);
  });

  it('secret mutations + cold-store internals land in 365d bucket', () => {
    expect(ACCESS_LOG_WARM_DAYS['secret.set']).toBe(365);
    expect(ACCESS_LOG_WARM_DAYS['secret.delete']).toBe(365);
    expect(ACCESS_LOG_WARM_DAYS['secret.reveal']).toBe(365);
    expect(ACCESS_LOG_WARM_DAYS['secret_scope.create']).toBe(365);
    expect(ACCESS_LOG_WARM_DAYS['archive_chunk']).toBe(365);
    expect(ACCESS_LOG_WARM_DAYS['purge_chunk']).toBe(365);
  });

  it('cold-store chunk lifecycle actions share retention (archive_chunk + purge_chunk)', () => {
    // Both are cold-store internals per docs/operator/security/audit-log.md
    // "Cold-store internals" row — 365d warm / forever cold.
    expect(ACCESS_LOG_WARM_DAYS['archive_chunk']).toBe(ACCESS_LOG_WARM_DAYS['purge_chunk']);
    expect(ACCESS_LOG_COLD_DAYS['archive_chunk']).toBe(ACCESS_LOG_COLD_DAYS['purge_chunk']);
    expect(ACCESS_LOG_COLD_DAYS['purge_chunk']).toBe('forever');
  });
});

describe('retention-policy — audit_log (Platform)', () => {
  it('compliance prefixes return 365d', () => {
    expect(auditLogWarmDays('plan.change')).toBe(365);
    expect(auditLogWarmDays('plan_config.update')).toBe(365);
    expect(auditLogWarmDays('member.removed')).toBe(365);
    expect(auditLogWarmDays('member.invite')).toBe(365);
    expect(auditLogWarmDays('invite.declined')).toBe(365);
    expect(auditLogWarmDays('role.assigned')).toBe(365);
    expect(auditLogWarmDays('platform-admin.org.disable')).toBe(365);
    expect(auditLogWarmDays('support-read.claimed')).toBe(365);
    expect(auditLogWarmDays('org.disable')).toBe(365);
  });

  it('compliance exact-match set returns 365d', () => {
    expect(auditLogWarmDays('archive_chunk')).toBe(365);
    expect(auditLogWarmDays('purge_chunk')).toBe(365);
    expect(auditLogWarmDays('replay_chunk')).toBe(365);
    expect(auditLogWarmDays('scheduled_job_failure')).toBe(365);
  });

  it('non-compliance actions default to 180d', () => {
    expect(auditLogWarmDays('environment.create')).toBe(180);
    expect(auditLogWarmDays('run.cancel')).toBe(180);
    expect(auditLogWarmDays('whatever.unknown')).toBe(180);
  });

  it('platform_operator actor promotes to 365d regardless of action', () => {
    expect(
      getAuditLogWarmDays({ action: 'environment.create', actorType: 'platform_operator' }),
    ).toBe(365);
    expect(getAuditLogWarmDays({ action: 'plan.change', actorType: 'user' })).toBe(365);
    expect(getAuditLogWarmDays({ action: 'environment.create', actorType: 'user' })).toBe(180);
  });
});

describe('retention-policy — secret_audit_log (Orchestrator)', () => {
  it('sampled resolves return 30d', () => {
    expect(secretAuditLogWarmDays('resolve')).toBe(30);
    expect(secretAuditLogWarmDays('resolve_named')).toBe(30);
  });

  it('mutations default to 365d', () => {
    expect(secretAuditLogWarmDays('set')).toBe(365);
    expect(secretAuditLogWarmDays('delete')).toBe(365);
    expect(secretAuditLogWarmDays('rotate')).toBe(365);
    expect(secretAuditLogWarmDays('scope.create')).toBe(365);
    expect(secretAuditLogWarmDays('whatever')).toBe(365);
  });

  it('outcome=denied promotes to 180d (forensic)', () => {
    expect(getSecretAuditLogWarmDays({ action: 'set', outcome: 'denied' })).toBe(180);
    expect(getSecretAuditLogWarmDays({ action: 'resolve', outcome: 'denied' })).toBe(180);
  });

  it('outcome=allowed uses the per-action lookup', () => {
    expect(getSecretAuditLogWarmDays({ action: 'set', outcome: 'allowed' })).toBe(365);
    expect(getSecretAuditLogWarmDays({ action: 'resolve', outcome: 'allowed' })).toBe(30);
  });
});

describe('retention-policy — minimum-TTL helpers', () => {
  it('minAccessLogWarmDays = 30 (lowest bucket)', () => {
    expect(minAccessLogWarmDays()).toBe(30);
  });

  it('minSecretAuditLogWarmDays = 30 (sampled-resolve bucket)', () => {
    expect(minSecretAuditLogWarmDays()).toBe(30);
  });

  it('minAuditLogWarmDays = 180', () => {
    expect(minAuditLogWarmDays()).toBe(180);
  });
});

describe('retention-policy — SQL fragment generators', () => {
  it('accessLogWarmSqlCase emits override + per-action branches', () => {
    const sql = accessLogWarmSqlCase();
    expect(sql).toMatch(/^CASE\b/);
    expect(sql).toMatch(/END$/);
    // Override 1: denied / error → 180 days.
    expect(sql).toContain(`WHEN outcome IN ('denied','error') THEN INTERVAL '180 days'`);
    // Override 2: platform_operator → 365 days.
    expect(sql).toContain(`WHEN actor_type = 'platform_operator' THEN INTERVAL '365 days'`);
    // Per-action 365d bucket should mention secret.set.
    expect(sql).toMatch(/INTERVAL '365 days'/);
    expect(sql).toContain("'secret.set'");
    // 180d bucket includes mutation.
    expect(sql).toContain("'run.cancel'");
    // ELSE branch defaults unknown actions to the conservative 180-day TTL,
    // matching the JS getter's UNKNOWN_ACTION_WARM_DAYS.
    expect(sql).toMatch(/ELSE INTERVAL '180 days'/);
  });

  it('accessLogWarmSqlCase emits the 30-day group in its own explicit WHEN clause, not the ELSE', () => {
    const sql = accessLogWarmSqlCase();
    // Every 30-day action must appear inside an explicit `WHEN action IN (...)
    // THEN INTERVAL '30 days'` clause — they must NOT silently fall through to
    // the ELSE (which is now reserved for genuinely-unknown actions at 180d).
    expect(sql).toMatch(/WHEN action IN \([^)]*\) THEN INTERVAL '30 days'/);
    const thirtyDayClause = sql.match(/WHEN action IN \(([^)]*)\) THEN INTERVAL '30 days'/);
    expect(thirtyDayClause).not.toBeNull();
    const inList = thirtyDayClause![1];
    for (const action of AccessLogAction.options) {
      if (ACCESS_LOG_WARM_DAYS[action] !== 30) continue;
      expect(inList).toContain(`'${action}'`);
    }
    // And the 30-day clause sits before the ELSE, not in it.
    const elseIdx = sql.indexOf('ELSE');
    const thirtyIdx = sql.indexOf("THEN INTERVAL '30 days'");
    expect(thirtyIdx).toBeGreaterThan(-1);
    expect(thirtyIdx).toBeLessThan(elseIdx);
  });

  it('accessLogWarmSqlCase covers every known action in some explicit WHEN list (no ELSE reliance)', () => {
    const sql = accessLogWarmSqlCase();
    // Now that the ELSE is reserved for unknown actions, EVERY known action
    // (including the 30-day group) must appear in an explicit IN list.
    for (const action of AccessLogAction.options) {
      expect(sql).toContain(`'${action}'`);
    }
  });

  it('accessLogWarmSqlCase ELSE agrees with getAccessLogWarmDays for an unknown action', () => {
    const sql = accessLogWarmSqlCase();
    // The SQL ELSE default must equal the JS getter's unknown-action default so
    // the pre-filter never archives unknown rows earlier than the getter would.
    const jsUnknown = getAccessLogWarmDays({
      action: 'totally.unknown.action' as never,
      outcome: 'allowed',
      actorType: 'user',
    });
    expect(jsUnknown).toBe(180);
    expect(sql).toContain(`ELSE INTERVAL '${jsUnknown} days'`);
  });

  it('accessLogWarmSqlCase per-action clauses agree with getAccessLogWarmDays (30d, 180d, 365d)', () => {
    const sql = accessLogWarmSqlCase();
    // A known 30-day action.
    const known30 = getAccessLogWarmDays({
      action: 'run.detail.read',
      outcome: 'allowed',
      actorType: 'user',
    });
    expect(known30).toBe(30);
    expect(sql).toMatch(
      new RegExp(`WHEN action IN \\([^)]*'run\\.detail\\.read'[^)]*\\) THEN INTERVAL '30 days'`),
    );
    // A known 180-day action.
    const known180 = getAccessLogWarmDays({
      action: 'run.cancel',
      outcome: 'allowed',
      actorType: 'user',
    });
    expect(known180).toBe(180);
    expect(sql).toMatch(
      new RegExp(`WHEN action IN \\([^)]*'run\\.cancel'[^)]*\\) THEN INTERVAL '180 days'`),
    );
    // A known 365-day action.
    const known365 = getAccessLogWarmDays({
      action: 'secret.set',
      outcome: 'allowed',
      actorType: 'user',
    });
    expect(known365).toBe(365);
    expect(sql).toMatch(
      new RegExp(`WHEN action IN \\([^)]*'secret\\.set'[^)]*\\) THEN INTERVAL '365 days'`),
    );
  });

  it('auditLogWarmSqlCase emits prefix patterns + exact-match IN list', () => {
    const sql = auditLogWarmSqlCase();
    expect(sql).toMatch(/^CASE\b/);
    expect(sql).toMatch(/END$/);
    expect(sql).toContain("action LIKE 'plan.%'");
    expect(sql).toContain("action LIKE 'platform-admin.%'");
    expect(sql).toContain("'archive_chunk'");
    expect(sql).toMatch(/ELSE INTERVAL '180 days'/);
  });

  it('auditLogWarmSqlCase does NOT reference actor_type or outcome (Platform table has neither column)', () => {
    const sql = auditLogWarmSqlCase();
    expect(sql).not.toContain('actor_type');
    expect(sql).not.toContain('outcome');
  });

  it('secretAuditLogWarmSqlCase emits denied override + sampled-resolve branch', () => {
    const sql = secretAuditLogWarmSqlCase();
    expect(sql).toMatch(/^CASE\b/);
    expect(sql).toMatch(/END$/);
    expect(sql).toContain(`WHEN outcome = 'denied' THEN INTERVAL '180 days'`);
    expect(sql).toContain("'resolve'");
    expect(sql).toContain("'resolve_named'");
    expect(sql).toMatch(/ELSE INTERVAL '365 days'/);
    // No actor_type column on this table.
    expect(sql).not.toContain('actor_type');
  });
});

describe('retention-policy — cold retention (Phase 2)', () => {
  it('ACCESS_LOG_COLD_DAYS is exhaustive over AccessLogAction.options', () => {
    const mapped = new Set(Object.keys(ACCESS_LOG_COLD_DAYS));
    for (const action of AccessLogAction.options) {
      expect(mapped.has(action)).toBe(true);
    }
    expect(mapped.size).toBe(AccessLogAction.options.length);
  });

  it('per-action cold lookup returns the mapped value for allowed/user', () => {
    for (const action of AccessLogAction.options) {
      expect(getAccessLogColdDays({ action, outcome: 'allowed', actorType: 'user' })).toBe(
        ACCESS_LOG_COLD_DAYS[action],
      );
    }
  });

  it('outcome=denied promotes any action to 730d cold (forensic override)', () => {
    expect(
      getAccessLogColdDays({ action: 'run.detail.read', outcome: 'denied', actorType: 'user' }),
    ).toBe(730);
    expect(
      getAccessLogColdDays({ action: 'secret.set', outcome: 'denied', actorType: 'user' }),
    ).toBe(730);
    expect(
      getAccessLogColdDays({ action: 'diagnostics.read', outcome: 'denied', actorType: 'user' }),
    ).toBe(730);
  });

  it('outcome=error promotes to 730d cold', () => {
    expect(
      getAccessLogColdDays({ action: 'run.detail.read', outcome: 'error', actorType: 'user' }),
    ).toBe(730);
  });

  it('actorType=platform_operator promotes any action to forever (compliance)', () => {
    expect(
      getAccessLogColdDays({
        action: 'run.detail.read',
        outcome: 'allowed',
        actorType: 'platform_operator',
      }),
    ).toBe('forever');
    expect(
      getAccessLogColdDays({
        action: 'diagnostics.read',
        outcome: 'allowed',
        actorType: 'platform_operator',
      }),
    ).toBe('forever');
  });

  it('outcome override beats actorType override (more conservative wins for cold)', () => {
    // denied gives 730, platform_operator gives forever — forever is the more
    // conservative cold retention, so platform_operator wins ONLY if the row
    // is `allowed`. A denied row from a platform_operator should still be
    // 730 days because the outcome check fires first.
    expect(
      getAccessLogColdDays({
        action: 'run.detail.read',
        outcome: 'denied',
        actorType: 'platform_operator',
      }),
    ).toBe(730);
  });

  it('auditLogColdDays returns forever for compliance prefixes / exact actions', () => {
    expect(auditLogColdDays('plan.change')).toBe('forever');
    expect(auditLogColdDays('member.invite')).toBe('forever');
    expect(auditLogColdDays('platform-admin.org.disable')).toBe('forever');
    expect(auditLogColdDays('support-read.claimed')).toBe('forever');
    expect(auditLogColdDays('archive_chunk')).toBe('forever');
    expect(auditLogColdDays('purge_chunk')).toBe('forever');
    expect(auditLogColdDays('replay_chunk')).toBe('forever');
    expect(auditLogColdDays('scheduled_job_failure')).toBe('forever');
  });

  it('auditLogColdDays returns 730 for tenant-plane mutations / unknown actions', () => {
    expect(auditLogColdDays('environment.create')).toBe(730);
    expect(auditLogColdDays('run.cancel')).toBe(730);
    expect(auditLogColdDays('whatever.unknown')).toBe(730);
  });

  it('getAuditLogColdDays platform_operator override → forever', () => {
    expect(getAuditLogColdDays({ action: 'run.cancel', actorType: 'platform_operator' })).toBe(
      'forever',
    );
    // Compliance action stays forever even without override.
    expect(getAuditLogColdDays({ action: 'plan.change', actorType: 'user' })).toBe('forever');
  });

  it('secretAuditLogColdDays — sampled-resolve 180d, mutations forever', () => {
    expect(secretAuditLogColdDays('resolve')).toBe(180);
    expect(secretAuditLogColdDays('resolve_named')).toBe(180);
    expect(secretAuditLogColdDays('rotate')).toBe('forever');
    expect(secretAuditLogColdDays('set')).toBe('forever');
    expect(secretAuditLogColdDays('whatever.unknown')).toBe('forever');
  });

  it('getSecretAuditLogColdDays denied override → 730d', () => {
    expect(getSecretAuditLogColdDays({ action: 'resolve', outcome: 'denied' })).toBe(730);
    expect(getSecretAuditLogColdDays({ action: 'set', outcome: 'denied' })).toBe(730);
    expect(getSecretAuditLogColdDays({ action: 'resolve', outcome: 'allowed' })).toBe(180);
  });
});

describe('retention-policy — unknown-action fallback (defensive)', () => {
  it('getAccessLogWarmDays returns the conservative default for unknown actions', () => {
    // Real-world drivers: E2E synthetic action names, future enum additions
    // not yet in the deployed binary, post-rollback action strings.
    const warm = getAccessLogWarmDays({
      action: 'cold-store-e2e.access-action-7' as never,
      outcome: 'allowed',
      actorType: 'user',
    });
    expect(warm).toBe(180);
  });

  it('getAccessLogColdDays returns the conservative default for unknown actions', () => {
    const cold = getAccessLogColdDays({
      action: 'cold-store-e2e.access-action-7' as never,
      outcome: 'allowed',
      actorType: 'user',
    });
    expect(cold).toBe(730);
  });

  it('overrides still apply on unknown-action rows (denied → 180/730, operator → 365/forever)', () => {
    const action = 'made-up.future.action' as never;
    expect(getAccessLogWarmDays({ action, outcome: 'denied', actorType: 'user' })).toBe(180);
    expect(getAccessLogColdDays({ action, outcome: 'denied', actorType: 'user' })).toBe(730);
    expect(
      getAccessLogWarmDays({ action, outcome: 'allowed', actorType: 'platform_operator' }),
    ).toBe(365);
    expect(
      getAccessLogColdDays({ action, outcome: 'allowed', actorType: 'platform_operator' }),
    ).toBe('forever');
  });
});
