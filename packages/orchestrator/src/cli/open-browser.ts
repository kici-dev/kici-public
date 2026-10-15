import { exec } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Best-effort: the caller always prints the URL too, so a headless host falls
 * back to copy-paste. `KICI_BROWSER_CMD` overrides the launcher as in
 * `kici login`: `none` suppresses it (tests, headless capture), any other
 * value runs with `{url}` substituted.
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
