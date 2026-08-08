import { describe, it, expect } from 'vitest';
import {
  buildContainerHardening,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_NANO_CPUS,
  type SandboxHardeningOptions,
} from './container-hardening.js';

/** A hardened-by-default option baseline for tests to spread + override. */
function baseOpts(overrides: Partial<SandboxHardeningOptions> = {}): SandboxHardeningOptions {
  return {
    hardened: true,
    readonlyRootfs: false,
    pidsLimit: DEFAULT_PIDS_LIMIT,
    memoryBytes: DEFAULT_MEMORY_BYTES,
    nanoCpus: DEFAULT_NANO_CPUS,
    networkMode: 'default',
    ...overrides,
  };
}

describe('buildContainerHardening', () => {
  describe('hardened defaults', () => {
    it('drops all capabilities and sets no-new-privileges', () => {
      const { hostConfig } = buildContainerHardening(baseOpts());
      expect(hostConfig.CapDrop).toEqual(['ALL']);
      expect(hostConfig.SecurityOpt).toEqual(['no-new-privileges']);
      expect(hostConfig.CapAdd).toBeUndefined();
    });

    it('sets pids/memory/cpu cgroup caps from the resolved limits', () => {
      const { hostConfig } = buildContainerHardening(
        baseOpts({ pidsLimit: 256, memoryBytes: 1_073_741_824, nanoCpus: 500_000_000 }),
      );
      expect(hostConfig.PidsLimit).toBe(256);
      expect(hostConfig.Memory).toBe(1_073_741_824);
      expect(hostConfig.NanoCpus).toBe(500_000_000);
    });

    it('caps MemorySwap at Memory so swap cannot spill past the memory bound', () => {
      const { hostConfig } = buildContainerHardening(baseOpts({ memoryBytes: 1_073_741_824 }));
      expect(hostConfig.MemorySwap).toBe(1_073_741_824);
    });

    it('mounts a private tmpfs at /tmp with explicit exec,nosuid,nodev options', () => {
      const { hostConfig } = buildContainerHardening(baseOpts());
      // Options are explicit (not empty) so docker and podman agree: docker
      // defaults an empty-option tmpfs to noexec, which breaks jobs that exec
      // from /tmp (npm/pnpm install scripts). `exec` matches the podman/bwrap
      // posture; nosuid,nodev keep the hardening.
      expect(hostConfig.Tmpfs).toEqual({ '/tmp': 'rw,exec,nosuid,nodev' });
    });

    it('does NOT set ReadonlyRootfs or User by default (both opt-in)', () => {
      const { hostConfig, user } = buildContainerHardening(baseOpts());
      expect(hostConfig.ReadonlyRootfs).toBeUndefined();
      expect(user).toBeUndefined();
    });

    it('exposes the operator-visible default constants', () => {
      expect(DEFAULT_PIDS_LIMIT).toBe(512);
      expect(DEFAULT_MEMORY_BYTES).toBe(2 * 1024 * 1024 * 1024);
      expect(DEFAULT_NANO_CPUS).toBe(2 * 1_000_000_000);
    });
  });

  describe('opt-ins and overrides', () => {
    it('sets ReadonlyRootfs when opted in via config', () => {
      const { hostConfig } = buildContainerHardening(baseOpts({ readonlyRootfs: true }));
      expect(hostConfig.ReadonlyRootfs).toBe(true);
    });

    it('sets User from the config override', () => {
      const { user } = buildContainerHardening(baseOpts({ user: '1000:1000' }));
      expect(user).toBe('1000:1000');
    });

    it('sets NetworkMode none for the isolated network posture', () => {
      const { hostConfig } = buildContainerHardening(baseOpts({ networkMode: 'none' }));
      expect(hostConfig.NetworkMode).toBe('none');
    });

    it('leaves NetworkMode unset for the default network posture', () => {
      const { hostConfig } = buildContainerHardening(baseOpts({ networkMode: 'default' }));
      expect(hostConfig.NetworkMode).toBeUndefined();
    });
  });

  describe('resolved grant (escape hatch)', () => {
    it('adds requested capabilities as CapAdd while still dropping ALL', () => {
      const { hostConfig } = buildContainerHardening(
        baseOpts({ grant: { capabilities: ['NET_ADMIN'] } }),
      );
      expect(hostConfig.CapDrop).toEqual(['ALL']);
      expect(hostConfig.CapAdd).toEqual(['NET_ADMIN']);
    });

    it('honors a grant network of host over the config mode', () => {
      const { hostConfig } = buildContainerHardening(
        baseOpts({ networkMode: 'none', grant: { network: 'host' } }),
      );
      expect(hostConfig.NetworkMode).toBe('host');
    });

    it('honors a grant readonlyRootfs and user over config', () => {
      const { hostConfig, user } = buildContainerHardening(
        baseOpts({ readonlyRootfs: false, grant: { readonlyRootfs: true, user: 'worker' } }),
      );
      expect(hostConfig.ReadonlyRootfs).toBe(true);
      expect(user).toBe('worker');
    });

    it('does not set CapAdd for an empty capabilities grant', () => {
      const { hostConfig } = buildContainerHardening(baseOpts({ grant: { capabilities: [] } }));
      expect(hostConfig.CapAdd).toBeUndefined();
    });
  });

  describe('rollback affordance', () => {
    it('emits an empty posture when hardened is false', () => {
      const { hostConfig, user } = buildContainerHardening(baseOpts({ hardened: false }));
      expect(hostConfig).toEqual({});
      expect(user).toBeUndefined();
    });
  });
});
