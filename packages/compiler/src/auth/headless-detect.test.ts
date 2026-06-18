import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isHeadless } from './headless-detect.js';

describe('isHeadless', () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;

  beforeEach(() => {
    // Start with a clean env for each test
    process.env = { ...originalEnv };
    // Clear all headless-related env vars
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_TTY;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.container;
    delete process.env.DOCKER_CONTAINER;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('SSH detection', () => {
    it('returns true when SSH_CLIENT is set', () => {
      process.env.SSH_CLIENT = '192.168.1.1 12345 22';
      expect(isHeadless()).toBe(true);
    });

    it('returns true when SSH_TTY is set', () => {
      process.env.SSH_TTY = '/dev/pts/0';
      expect(isHeadless()).toBe(true);
    });
  });

  describe('CI detection', () => {
    it('returns true when CI is set', () => {
      process.env.CI = 'true';
      expect(isHeadless()).toBe(true);
    });

    it('returns true when GITHUB_ACTIONS is set', () => {
      process.env.GITHUB_ACTIONS = 'true';
      expect(isHeadless()).toBe(true);
    });

    it('returns true when GITLAB_CI is set', () => {
      process.env.GITLAB_CI = 'true';
      expect(isHeadless()).toBe(true);
    });
  });

  describe('container detection', () => {
    it('returns true when container env is set', () => {
      process.env.container = 'podman';
      expect(isHeadless()).toBe(true);
    });

    it('returns true when DOCKER_CONTAINER is set', () => {
      process.env.DOCKER_CONTAINER = '1';
      expect(isHeadless()).toBe(true);
    });
  });

  describe('Linux display detection', () => {
    it('returns true on Linux with no DISPLAY and no WAYLAND_DISPLAY', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      expect(isHeadless()).toBe(true);
    });

    it('returns false on Linux with DISPLAY set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.DISPLAY = ':0';
      expect(isHeadless()).toBe(false);
    });

    it('returns false on Linux with WAYLAND_DISPLAY set', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      expect(isHeadless()).toBe(false);
    });
  });

  describe('desktop detection', () => {
    it('returns false on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      expect(isHeadless()).toBe(false);
    });

    it('returns false on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(isHeadless()).toBe(false);
    });
  });
});
