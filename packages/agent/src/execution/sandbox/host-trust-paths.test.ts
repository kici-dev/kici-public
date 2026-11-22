import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRUST_MOUNT_ROOT,
  applyTrustPathPlan,
  hostSuppliedTrustPaths,
  planTrustPathMounts,
  type InspectedTrustPath,
} from './host-trust-paths.js';

describe('hostSuppliedTrustPaths', () => {
  const hostEnv = {
    GIT_SSL_CAINFO: '/etc/kici/ca-bundle.pem',
    SSL_CERT_FILE: '/etc/pki/tls/cert.pem',
    PATH: '/usr/bin',
  };

  it('returns the trust settings the host supplied', () => {
    const env = { ...hostEnv, FORCE_COLOR: '1' };
    expect(hostSuppliedTrustPaths(env, new Set(), hostEnv)).toEqual({
      GIT_SSL_CAINFO: '/etc/kici/ca-bundle.pem',
      SSL_CERT_FILE: '/etc/pki/tls/cert.pem',
    });
  });

  // fails-when: a value the job sets for its own image is treated as a host
  // path, and then bound over (or dropped from) the job's filesystem.
  it('leaves a setting the job supplies alone, even when it equals the host value', () => {
    const env = { ...hostEnv };
    expect(hostSuppliedTrustPaths(env, new Set(['SSL_CERT_FILE']), hostEnv)).toEqual({
      GIT_SSL_CAINFO: '/etc/kici/ca-bundle.pem',
    });
  });

  it('ignores a value that differs from the host value', () => {
    const env = { ...hostEnv, GIT_SSL_CAINFO: '/image/ca.pem' };
    expect(hostSuppliedTrustPaths(env, new Set(), hostEnv)).toEqual({
      SSL_CERT_FILE: '/etc/pki/tls/cert.pem',
    });
  });
});

describe('planTrustPathMounts', () => {
  const files = new Map<string, string>([
    ['/etc/kici/ca-bundle.pem', '/etc/kici/ca-bundle.pem'],
    ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/certs/ca-certificates.crt'],
    ['/etc/alt/ca.pem', '/etc/kici/ca-bundle.pem'],
  ]);
  const dirs = new Set(['/etc/kici/certs', '/opt/certs']);
  const inspect = (path: string): InspectedTrustPath | undefined => {
    if (files.has(path)) return { realPath: files.get(path)!, kind: 'file' };
    if (dirs.has(path)) return { realPath: path, kind: 'directory' };
    if (path === '/run/agent.sock') return { realPath: path, kind: 'other' };
    return undefined;
  };

  // fails-when: the standard host path mounts at the same location, over the
  // image's own trust store.
  it('mounts each usable path under /run/kici/trust and rewrites the setting', () => {
    expect(
      planTrustPathMounts({ SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' }, inspect),
    ).toEqual({
      mounts: [
        {
          source: '/etc/ssl/certs/ca-certificates.crt',
          target: `${TRUST_MOUNT_ROOT}/0/ca-certificates.crt`,
        },
      ],
      env: { SSL_CERT_FILE: '/run/kici/trust/0/ca-certificates.crt' },
      unavailableKeys: [],
    });
  });

  it('mounts one resolved file once and drops a setting whose path is missing', () => {
    const plan = planTrustPathMounts(
      {
        GIT_SSL_CAINFO: '/etc/kici/ca-bundle.pem',
        NODE_EXTRA_CA_CERTS: '/etc/alt/ca.pem',
        SSL_CERT_FILE: '/nowhere/cert.pem',
      },
      inspect,
    );
    expect(plan).toEqual({
      mounts: [{ source: '/etc/kici/ca-bundle.pem', target: '/run/kici/trust/0/ca-bundle.pem' }],
      env: {
        GIT_SSL_CAINFO: '/run/kici/trust/0/ca-bundle.pem',
        NODE_EXTRA_CA_CERTS: '/run/kici/trust/0/ca-bundle.pem',
      },
      unavailableKeys: ['SSL_CERT_FILE'],
    });
  });

  it('mounts the existing directories of an SSL_CERT_DIR list', () => {
    expect(
      planTrustPathMounts({ SSL_CERT_DIR: '/etc/kici/certs:/missing:/opt/certs' }, inspect),
    ).toEqual({
      mounts: [
        { source: '/etc/kici/certs', target: '/run/kici/trust/0/certs' },
        { source: '/opt/certs', target: '/run/kici/trust/1/certs' },
      ],
      env: { SSL_CERT_DIR: '/run/kici/trust/0/certs:/run/kici/trust/1/certs' },
      unavailableKeys: [],
    });
    expect(planTrustPathMounts({ SSL_CERT_DIR: '/missing:/also-missing' }, inspect)).toEqual({
      mounts: [],
      env: {},
      unavailableKeys: ['SSL_CERT_DIR'],
    });
  });

  // fails-when: a resolved name of '..' or '.' collapses the target onto the trust root
  // breaks-if-wrong: an ordinary resolved name is kept (the tests above)
  it('uses a fixed name when the resolved path has no usable last component', () => {
    const odd = (path: string): InspectedTrustPath | undefined =>
      path === '/odd' ? { realPath: '/x/..', kind: 'directory' } : undefined;
    expect(planTrustPathMounts({ SSL_CERT_DIR: '/odd' }, odd).mounts).toEqual([
      { source: '/x/..', target: '/run/kici/trust/0/trust' },
    ]);
  });

  // fails-when: a path of the wrong kind (a directory for a CA file, a file
  // for a certificate directory, a socket) or a relative path is mounted.
  it('drops a path that is relative or of the wrong kind', () => {
    expect(
      planTrustPathMounts(
        {
          GIT_SSL_CAINFO: '/etc/kici/certs',
          GIT_SSL_CAPATH: '/etc/kici/ca-bundle.pem',
          SSL_CERT_FILE: '/run/agent.sock',
          NODE_EXTRA_CA_CERTS: 'ca-bundle.pem',
        },
        inspect,
      ),
    ).toEqual({
      mounts: [],
      env: {},
      unavailableKeys: ['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'],
    });
  });

  describe('against the real filesystem', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'kici-trust-plan-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('mounts the target of a symlink to a file, named after the resolved file', async () => {
      await writeFile(join(dir, 'real.pem'), 'ca\n');
      await symlink(join(dir, 'real.pem'), join(dir, 'ca.pem'));
      expect(planTrustPathMounts({ GIT_SSL_CAINFO: join(dir, 'ca.pem') }).mounts).toEqual([
        { source: await realpath(join(dir, 'real.pem')), target: '/run/kici/trust/0/real.pem' },
      ]);
    });

    // fails-when: '..' becomes the mount name, and the mount lands on
    //   /run/kici/trust itself, over every other trust mount
    it('names a directory given as <dir>/.. after the resolved directory', async () => {
      await mkdir(join(dir, 'certs', 'sub'), { recursive: true });
      const plan = planTrustPathMounts({ SSL_CERT_DIR: join(dir, 'certs', 'sub', '..') });
      expect(plan.mounts).toEqual([
        { source: await realpath(join(dir, 'certs')), target: '/run/kici/trust/0/certs' },
      ]);
      expect(plan.env).toEqual({ SSL_CERT_DIR: '/run/kici/trust/0/certs' });
    });

    // fails-when: the whole host root mounts into the job's filesystem
    it('drops SSL_CERT_DIR=/', () => {
      expect(planTrustPathMounts({ SSL_CERT_DIR: '/' })).toEqual({
        mounts: [],
        env: {},
        unavailableKeys: ['SSL_CERT_DIR'],
      });
    });

    it('drops a symlink to a directory and a dangling symlink', async () => {
      await mkdir(join(dir, 'certs'));
      await symlink(join(dir, 'certs'), join(dir, 'to-dir.pem'));
      await symlink(join(dir, 'gone.pem'), join(dir, 'dangling.pem'));
      expect(
        planTrustPathMounts({
          GIT_SSL_CAINFO: join(dir, 'to-dir.pem'),
          SSL_CERT_FILE: join(dir, 'dangling.pem'),
        }),
      ).toEqual({ mounts: [], env: {}, unavailableKeys: ['GIT_SSL_CAINFO', 'SSL_CERT_FILE'] });
    });
  });
});

describe('applyTrustPathPlan', () => {
  // breaks-if-wrong: an empty plan (no host trust settings) leaves the env equal.
  it('rewrites and drops only the planned settings', () => {
    const env = { PATH: '/usr/bin', GIT_SSL_CAINFO: '/h/ca.pem', SSL_CERT_FILE: '/h/x.pem' };
    expect(applyTrustPathPlan(env, { mounts: [], env: {}, unavailableKeys: [] })).toEqual(env);
    expect(
      applyTrustPathPlan(env, {
        mounts: [],
        env: { GIT_SSL_CAINFO: '/run/kici/trust/0/ca.pem' },
        unavailableKeys: ['SSL_CERT_FILE'],
      }),
    ).toEqual({ PATH: '/usr/bin', GIT_SSL_CAINFO: '/run/kici/trust/0/ca.pem' });
  });
});
