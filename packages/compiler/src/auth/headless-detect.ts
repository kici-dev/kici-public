/**
 * Detect if the current environment is headless (no browser available).
 *
 * Used to determine whether to use the PKCE localhost callback flow
 * (desktop) or the RFC 8628 device authorization flow (headless/SSH).
 *
 * Checks in order:
 * 1. SSH session (SSH_CLIENT, SSH_TTY)
 * 2. CI environments (CI, GITHUB_ACTIONS, GITLAB_CI)
 * 3. Container environments (container, DOCKER_CONTAINER)
 * 4. Linux without display server (no DISPLAY and no WAYLAND_DISPLAY)
 */
export function isHeadless(): boolean {
  // SSH session
  if (process.env.SSH_CLIENT || process.env.SSH_TTY) return true;

  // CI environments
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI) return true;

  // Container environments
  if (process.env.container || process.env.DOCKER_CONTAINER) return true;

  // Linux without display server
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }

  return false;
}
