import { exec } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a URL in the operator's default browser, best-effort. Used by the GitHub
 * App manifest setup flow to launch the create / install pages. Failure is
 * non-fatal — the caller always prints the URL too, so a headless host (or a
 * blocked launcher) just falls back to copy-paste.
 *
 * `KICI_BROWSER_CMD` overrides the launcher: `none` suppresses it entirely
 * (E2E / headless capture), any other value is run with `{url}` substituted —
 * mirroring the `kici login` convention.
 */
export function openBrowserBestEffort(url: string): void {
  const override = process.env.KICI_BROWSER_CMD;
  if (override === 'none') return;
  if (override) {
    exec(override.replace('{url}', url), () => {});
    return;
  }
  const cmd =
    platform() === 'darwin'
      ? `open ${JSON.stringify(url)}`
      : platform() === 'win32'
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;
  exec(cmd, () => {});
}
