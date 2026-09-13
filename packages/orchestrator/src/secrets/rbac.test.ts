/**
 * Tests for RbacEnforcer.
 *
 * Verifies the 3-role permission model:
 * - owner has all permissions
 * - admin has context + secret + audit, not token.manage or key.rotate
 * - auditor has context.read, audit.read, and run.read only
 * - requirePermission throws for unauthorized role
 * - canAccessSecretValues returns true for owner/admin, false for auditor
 */
import { describe, it, expect } from 'vitest';
import { RbacEnforcer, PermissionDeniedError, type Permission, type Role } from './rbac.js';

/**
 * Every member of `Permission`. The owner test below is named "has all
 * permissions", so this list has to actually be all of them — a partial list
 * lets a newly added permission be missing from the owner role unnoticed.
 * Keep it in sync with the union in `rbac.ts`.
 */
const ALL_PERMISSIONS: Permission[] = [
  'context.create',
  'context.read',
  'context.update',
  'context.delete',
  'secret.read',
  'secret.write',
  'secret.delete',
  'secret.reveal',
  'audit.read',
  'token.manage',
  'key.rotate',
  'run.read',
  'run.cancel',
  'event_log.read',
  'event_log.read_payload',
  'access_log.read',
  'scheduled_job.trigger',
  'attestation.retry',
  'event_dlq.read',
  'event_dlq.manage',
  'orchestrator.drain',
  'ci_trust.read',
  'ci_trust.admin',
];

describe('RbacEnforcer', () => {
  const enforcer = new RbacEnforcer();

  describe('owner role', () => {
    it('has all permissions', () => {
      for (const perm of ALL_PERMISSIONS) {
        expect(enforcer.hasPermission('owner', perm)).toBe(true);
      }
    });
  });

  describe('admin role', () => {
    it('has context, secret, and audit permissions', () => {
      const adminPerms: Permission[] = [
        'context.create',
        'context.read',
        'context.update',
        'context.delete',
        'secret.read',
        'secret.write',
        'secret.delete',
        'audit.read',
      ];
      for (const perm of adminPerms) {
        expect(enforcer.hasPermission('admin', perm)).toBe(true);
      }
    });

    it('does not have token.manage or key.rotate', () => {
      expect(enforcer.hasPermission('admin', 'token.manage')).toBe(false);
      expect(enforcer.hasPermission('admin', 'key.rotate')).toBe(false);
    });
  });

  describe('auditor role', () => {
    it('has context.read and audit.read only', () => {
      expect(enforcer.hasPermission('auditor', 'context.read')).toBe(true);
      expect(enforcer.hasPermission('auditor', 'audit.read')).toBe(true);
    });

    it('does not have write or delete permissions', () => {
      const deniedPerms: Permission[] = [
        'context.create',
        'context.update',
        'context.delete',
        'secret.read',
        'secret.write',
        'secret.delete',
        'token.manage',
        'key.rotate',
        'attestation.retry',
        'orchestrator.drain',
        'ci_trust.read',
        'ci_trust.admin',
      ];
      for (const perm of deniedPerms) {
        expect(enforcer.hasPermission('auditor', perm)).toBe(false);
      }
    });
  });

  describe('orchestrator.drain permission', () => {
    it('owner and admin hold orchestrator.drain', () => {
      expect(enforcer.hasPermission('owner', 'orchestrator.drain')).toBe(true);
      expect(enforcer.hasPermission('admin', 'orchestrator.drain')).toBe(true);
    });
    it('auditor does NOT hold orchestrator.drain', () => {
      expect(enforcer.hasPermission('auditor', 'orchestrator.drain')).toBe(false);
    });
  });

  describe('attestation.retry permission', () => {
    it('owner and admin hold attestation.retry', () => {
      expect(enforcer.hasPermission('owner', 'attestation.retry')).toBe(true);
      expect(enforcer.hasPermission('admin', 'attestation.retry')).toBe(true);
    });
    it('auditor does NOT hold attestation.retry', () => {
      expect(enforcer.hasPermission('auditor', 'attestation.retry')).toBe(false);
    });
  });

  describe('ci_trust permissions', () => {
    it('owner and admin hold ci_trust.read and ci_trust.admin', () => {
      for (const role of ['owner', 'admin'] as const) {
        expect(enforcer.hasPermission(role, 'ci_trust.read')).toBe(true);
        expect(enforcer.hasPermission(role, 'ci_trust.admin')).toBe(true);
      }
    });
    it('auditor holds neither — the trust policy decides whether a fork PR runs', () => {
      expect(enforcer.hasPermission('auditor', 'ci_trust.read')).toBe(false);
      expect(enforcer.hasPermission('auditor', 'ci_trust.admin')).toBe(false);
    });
  });

  describe('requirePermission', () => {
    it('does not throw for authorized role', () => {
      expect(() => enforcer.requirePermission('owner', 'token.manage')).not.toThrow();
    });

    it('throws PermissionDeniedError for unauthorized role', () => {
      expect(() => enforcer.requirePermission('auditor', 'secret.write')).toThrow(
        PermissionDeniedError,
      );
    });

    it('includes role and permission in error', () => {
      try {
        enforcer.requirePermission('auditor', 'token.manage');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionDeniedError);
        const e = err as PermissionDeniedError;
        expect(e.role).toBe('auditor');
        expect(e.permission).toBe('token.manage');
      }
    });
  });

  describe('canAccessSecretValues', () => {
    it('returns true for owner', () => {
      expect(enforcer.canAccessSecretValues('owner')).toBe(true);
    });

    it('returns true for admin', () => {
      expect(enforcer.canAccessSecretValues('admin')).toBe(true);
    });

    it('returns false for auditor', () => {
      expect(enforcer.canAccessSecretValues('auditor')).toBe(false);
    });
  });
});
