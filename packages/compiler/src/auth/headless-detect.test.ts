import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { isHeadless } from './headless-detect.js';

const wsl = vi.hoisted(() => ({ isWsl: false, canAccessPowerShell: vi.fn() }));

vi.mock('wsl-utils', () => ({
  // A getter, because `isWsl` is a plain boolean export that each test needs to
  // vary — assigning to a mocked namespace property is not allowed.
  get isWsl() {
    return wsl.isWsl;
  },
  canAccessPowerShell: wsl.canAccessPowerShell,
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

describe('isHeadless', () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;

  beforeEach(() => {
    // Start with a clean env for each test
    process.env = { ...originalEnv };
    // Clear all headless-related env vars
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_TTY;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.container;
    delete process.env.DOCKER_CONTAINER;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    vi.mocked(existsSync).mockReturnValue(false);
    wsl.isWsl = false;
    wsl.canAccessPowerShell.mockReset();
    wsl.canAccessPowerShell.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('SSH detection', () => {
    it('returns true when SSH_CLIENT is set', async () => {
      process.env.SSH_CLIENT = '192.168.1.1 12345 22';
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when SSH_TTY is set', async () => {
      process.env.SSH_TTY = '/dev/pts/0';
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when only SSH_CONNECTION survives', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      process.env.SSH_CONNECTION = '192.168.1.1 12345 192.168.1.2 22';
      expect(await isHeadless()).toBe(true);
    });
  });

  describe('CI detection', () => {
    beforeEach(() => {
      // Pin a desktop platform so every case here proves the CI branch fired,
      // not the "linux without a display server" fallback further down.
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    });

    it('returns true when CI is set', async () => {
      process.env.CI = 'true';
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when GITHUB_ACTIONS is set', async () => {
      process.env.GITHUB_ACTIONS = 'true';
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when GITLAB_CI is set', async () => {
      process.env.GITLAB_CI = 'true';
      expect(await isHeadless()).toBe(true);
    });

    it('returns false when CI is the explicit opt-out value "false"', async () => {
      process.env.CI = 'false';
      expect(await isHeadless()).toBe(false);
    });

    it('returns false when CI is the explicit opt-out value "0"', async () => {
      process.env.CI = '0';
      expect(await isHeadless()).toBe(false);
    });

    it('lets GITHUB_ACTIONS win over the CI="false" opt-out', async () => {
      process.env.CI = 'false';
      process.env.GITHUB_ACTIONS = 'true';
      expect(await isHeadless()).toBe(true);
    });

    it('lets GITLAB_CI win over the CI="false" opt-out', async () => {
      process.env.CI = 'false';
      process.env.GITLAB_CI = 'true';
      expect(await isHeadless()).toBe(true);
    });
  });

  describe('container detection', () => {
    it('returns true when container env is set', async () => {
      process.env.container = 'podman';
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when DOCKER_CONTAINER is set', async () => {
      process.env.DOCKER_CONTAINER = '1';
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when /run/.containerenv exists (podman)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.DISPLAY = ':0';
      vi.mocked(existsSync).mockImplementation((p) => p === '/run/.containerenv');
      expect(await isHeadless()).toBe(true);
    });

    it('returns true when /.dockerenv exists (docker)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.DISPLAY = ':0';
      vi.mocked(existsSync).mockImplementation((p) => p === '/.dockerenv');
      expect(await isHeadless()).toBe(true);
    });
  });

  describe('Linux display detection', () => {
    it('returns true on Linux with no DISPLAY and no WAYLAND_DISPLAY', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      expect(await isHeadless()).toBe(true);
    });

    it('returns false on Linux with DISPLAY set', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.DISPLAY = ':0';
      expect(await isHeadless()).toBe(false);
    });

    it('returns false on Linux with WAYLAND_DISPLAY set', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      expect(await isHeadless()).toBe(false);
    });
  });

  describe('WSL detection', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      // WSL has no DISPLAY/WAYLAND — that is exactly the fallback we override.
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      wsl.isWsl = true;
    });

    it('returns false on WSL when Windows interop is reachable', async () => {
      wsl.canAccessPowerShell.mockResolvedValue(true);
      expect(await isHeadless()).toBe(false);
    });

    it('returns true on WSL when Windows interop is not reachable', async () => {
      wsl.canAccessPowerShell.mockResolvedValue(false);
      expect(await isHeadless()).toBe(true);
    });

    it('returns true for a container on a WSL2 host without probing interop', async () => {
      vi.mocked(existsSync).mockImplementation((p) => p === '/.dockerenv');
      expect(await isHeadless()).toBe(true);
      expect(wsl.canAccessPowerShell).not.toHaveBeenCalled();
    });

    it('returns true for an SSH session into WSL without probing interop', async () => {
      process.env.SSH_CLIENT = '192.168.1.1 12345 22';
      expect(await isHeadless()).toBe(true);
      expect(wsl.canAccessPowerShell).not.toHaveBeenCalled();
    });

    it('returns true on WSL when only SSH_CONNECTION survives', async () => {
      // `open` refuses the Windows browser for any of the three SSH markers, so
      // choosing the browser flow here would strand the user on a launch that
      // silently displays nothing.
      process.env.SSH_CONNECTION = '192.168.1.1 12345 192.168.1.2 22';
      expect(await isHeadless()).toBe(true);
      expect(wsl.canAccessPowerShell).not.toHaveBeenCalled();
    });

    it('returns true for a CI runner on WSL (CI wins over WSL)', async () => {
      process.env.CI = 'true';
      expect(await isHeadless()).toBe(true);
    });

    it('still returns true on bare Linux with no display and no WSL', async () => {
      wsl.isWsl = false;
      expect(await isHeadless()).toBe(true);
    });

    it('returns false on non-linux platforms', async () => {
      wsl.isWsl = false;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(await isHeadless()).toBe(false);
    });
  });

  describe('WSL interop probe deadline', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      wsl.isWsl = true;
    });

    it('returns true when the interop probe never answers', async () => {
      // A hung 9p mount to the Windows drive: the fs.access never settles.
      wsl.canAccessPowerShell.mockReturnValue(new Promise(() => {}));
      expect(await isHeadless({ probeTimeoutMs: 10 })).toBe(true);
    });

    it('returns false when the probe answers reachable before the deadline', async () => {
      wsl.canAccessPowerShell.mockResolvedValue(true);
      expect(await isHeadless({ probeTimeoutMs: 10 })).toBe(false);
    });

    it('returns true when the probe answers unreachable before the deadline', async () => {
      wsl.canAccessPowerShell.mockResolvedValue(false);
      expect(await isHeadless({ probeTimeoutMs: 10 })).toBe(true);
    });

    it('does not raise an unhandled rejection when the abandoned probe rejects later', async () => {
      wsl.canAccessPowerShell.mockReturnValue(
        new Promise((_resolve, rejectProbe) => {
          setTimeout(() => rejectProbe(new Error('mount gone')), 20);
        }),
      );
      const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
      try {
        expect(await isHeadless({ probeTimeoutMs: 5 })).toBe(true);
        // Outlive the probe's own rejection so a missing catch would surface.
        await new Promise((r) => setTimeout(r, 60));
        expect(onUnhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('announces the timeout exactly once, and only when the probe times out', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        wsl.canAccessPowerShell.mockResolvedValue(true);
        await isHeadless({ probeTimeoutMs: 10 });
        const quietCalls = logSpy.mock.calls.length;

        wsl.canAccessPowerShell.mockReturnValue(new Promise(() => {}));
        await isHeadless({ probeTimeoutMs: 10 });

        expect(logSpy.mock.calls.length).toBe(quietCalls + 1);
        expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('device flow');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('desktop detection', () => {
    it('returns false on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(await isHeadless()).toBe(false);
    });

    it('returns false on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(await isHeadless()).toBe(false);
    });
  });
});
