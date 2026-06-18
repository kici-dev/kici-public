import { describe, it, expect, vi } from 'vitest';
import {
  ClusterIdentity,
  clusterSentinelKey,
  type ClusterIdentityDeps,
} from './cluster-identity.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

function makeMockDb(clusterId: string | null) {
  return createMockDb({
    selectFirstRow: clusterId ? { value: clusterId } : undefined,
  }).db as unknown as ClusterIdentityDeps['db'];
}

function createMockS3(existingContent: string | null = null) {
  return {
    getObject: vi.fn().mockResolvedValue(existingContent),
    putObject: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ClusterIdentity', () => {
  const TEST_CLUSTER_ID = '550e8400-e29b-41d4-a716-446655440000';

  describe('getClusterId()', () => {
    it('returns UUID from cluster_meta table', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const ci = new ClusterIdentity({ db });

      const result = await ci.getClusterId();
      expect(result).toBe(TEST_CLUSTER_ID);
    });

    it('throws if cluster_id not found', async () => {
      const db = makeMockDb(null);
      const ci = new ClusterIdentity({ db });

      await expect(ci.getClusterId()).rejects.toThrow('cluster_id not found');
    });
  });

  describe('validateS3Sentinel()', () => {
    it('writes sentinel if not exists', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const s3Client = createMockS3(null);
      const ci = new ClusterIdentity({
        db,
        s3Client,
        storageBucket: 'test-bucket',
      });

      await ci.validateS3Sentinel();

      expect(s3Client.putObject).toHaveBeenCalledWith(
        'test-bucket',
        '.kici-cluster-id',
        TEST_CLUSTER_ID,
      );
    });

    it('succeeds when sentinel matches', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const s3Client = createMockS3(TEST_CLUSTER_ID);
      const ci = new ClusterIdentity({
        db,
        s3Client,
        storageBucket: 'test-bucket',
      });

      await expect(ci.validateS3Sentinel()).resolves.toBeUndefined();
      expect(s3Client.putObject).not.toHaveBeenCalled();
    });

    it('throws on mismatch', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const s3Client = createMockS3('different-cluster-id');
      const ci = new ClusterIdentity({
        db,
        s3Client,
        storageBucket: 'test-bucket',
      });

      await expect(ci.validateS3Sentinel()).rejects.toThrow('Cluster identity mismatch');
    });

    it('skips when no S3 configured', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const ci = new ClusterIdentity({ db });

      // Should not throw, should not try to read cluster_id
      await expect(ci.validateS3Sentinel()).resolves.toBeUndefined();
    });

    it('writes sentinel under storage prefix', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const s3Client = createMockS3(null);
      const ci = new ClusterIdentity({
        db,
        s3Client,
        storageBucket: 'shared-bucket',
        storagePrefix: 'cluster-a',
      });

      await ci.validateS3Sentinel();

      expect(s3Client.getObject).toHaveBeenCalledWith(
        'shared-bucket',
        'cluster-a/.kici-cluster-id',
      );
      expect(s3Client.putObject).toHaveBeenCalledWith(
        'shared-bucket',
        'cluster-a/.kici-cluster-id',
        TEST_CLUSTER_ID,
      );
    });

    it('strips trailing slash from storage prefix', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const s3Client = createMockS3(null);
      const ci = new ClusterIdentity({
        db,
        s3Client,
        storageBucket: 'shared-bucket',
        storagePrefix: 'cluster-a/',
      });

      await ci.validateS3Sentinel();

      expect(s3Client.putObject).toHaveBeenCalledWith(
        'shared-bucket',
        'cluster-a/.kici-cluster-id',
        TEST_CLUSTER_ID,
      );
    });

    it('isolates two clusters sharing one bucket via different prefixes', async () => {
      // Cluster A's sentinel exists at cluster-a/.kici-cluster-id
      // Cluster B reads from cluster-b/ — should see null and write its own
      const db = makeMockDb('cluster-b-id');
      const s3Client = createMockS3(null); // mock returns null for cluster-b/
      const ci = new ClusterIdentity({
        db,
        s3Client,
        storageBucket: 'shared-bucket',
        storagePrefix: 'cluster-b',
      });

      await ci.validateS3Sentinel();

      expect(s3Client.getObject).toHaveBeenCalledWith(
        'shared-bucket',
        'cluster-b/.kici-cluster-id',
      );
      expect(s3Client.putObject).toHaveBeenCalledWith(
        'shared-bucket',
        'cluster-b/.kici-cluster-id',
        'cluster-b-id',
      );
    });
  });

  describe('clusterSentinelKey()', () => {
    it('returns root key when prefix is undefined', () => {
      expect(clusterSentinelKey()).toBe('.kici-cluster-id');
    });

    it('returns root key when prefix is empty string', () => {
      expect(clusterSentinelKey('')).toBe('.kici-cluster-id');
    });

    it('joins prefix and key with single slash', () => {
      expect(clusterSentinelKey('foo')).toBe('foo/.kici-cluster-id');
    });

    it('strips trailing slash from prefix', () => {
      expect(clusterSentinelKey('foo/')).toBe('foo/.kici-cluster-id');
      expect(clusterSentinelKey('foo//')).toBe('foo/.kici-cluster-id');
    });

    it('preserves nested prefix path', () => {
      expect(clusterSentinelKey('a/b/c')).toBe('a/b/c/.kici-cluster-id');
    });

    it('treats whitespace-only-after-trim as no prefix', () => {
      expect(clusterSentinelKey('/')).toBe('.kici-cluster-id');
    });
  });

  describe('validateAtStartup()', () => {
    it('returns cluster_id and logs it', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const ci = new ClusterIdentity({ db });

      const result = await ci.validateAtStartup('orch-instance-1');
      expect(result).toBe(TEST_CLUSTER_ID);
    });

    it('calls validateS3Sentinel internally', async () => {
      const db = makeMockDb(TEST_CLUSTER_ID);
      const s3Client = createMockS3(TEST_CLUSTER_ID);
      const ci = new ClusterIdentity({ db, s3Client, storageBucket: 'test-bucket' });

      await ci.validateAtStartup('orch-instance-1');

      // S3 sentinel was checked (getObject was called)
      expect(s3Client.getObject).toHaveBeenCalledWith('test-bucket', '.kici-cluster-id');
    });

    it('throws if cluster_id is not found (migration not run)', async () => {
      const db = makeMockDb(null);
      const ci = new ClusterIdentity({ db });

      await expect(ci.validateAtStartup('orch-instance-1')).rejects.toThrow('cluster_id not found');
    });
  });
});
