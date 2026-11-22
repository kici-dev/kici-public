/**
 * The Platform WebSocket URL an orchestrator install writes as
 * `KICI_PLATFORM_URL`, and the hint `kici-admin join` writes in its env-file
 * header. Kept free of prompt imports so the env-file writers can load it
 * without the interactive wizard.
 */

/**
 * Default Platform relay URL; kept in lockstep with the quickstart compose
 * `KICI_PLATFORM_URL`, pinned by orchestrator-wizard.test.ts.
 */
export const DEFAULT_PLATFORM_RELAY_URL = 'wss://api.kici.dev/ws';

/**
 * Validate a `--platform-url` value and return it trimmed. Only a `ws:` or
 * `wss:` URL is accepted, and never one carrying whitespace or a control
 * character: the value is written verbatim into an env file, where a newline
 * would start a second assignment and a tab or space would split the value.
 * A username or password is refused too, so no credential lands in the env
 * file. An http(s) URL is refused with a hint that keeps its base path.
 */
export function parsePlatformRelayUrl(value: string): string {
  const trimmed = value.trim();
  // Covers line breaks too (\s includes \r and \n).
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(
      '--platform-url must not contain whitespace, a line break or a control character',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `--platform-url must be a ws:// or wss:// URL such as ${DEFAULT_PLATFORM_RELAY_URL} (got "${trimmed}")`,
    );
  }
  // fails-when: a URL carrying a username or password is written into the env file
  // breaks-if-wrong: wss://kici.corp.example/ws, with no credentials, must still pass
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      '--platform-url must not carry a username or password: pass the Platform URL without credentials',
    );
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    // fails-when: the hint drops the base path of a Platform served under one
    const scheme = url.protocol === 'http:' ? 'ws' : 'wss';
    const hint = `${scheme}://${url.host}${url.pathname.replace(/\/+$/, '')}/ws`;
    throw new Error(
      `--platform-url takes the Platform's WebSocket URL, not its HTTP URL: ` +
        `use ${hint} (got "${trimmed}")`,
    );
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(
      `--platform-url must be a ws:// or wss:// URL such as ${DEFAULT_PLATFORM_RELAY_URL} (got "${trimmed}")`,
    );
  }
  return trimmed;
}
