import { shQuote } from './shell-quote.js';

/**
 * One OpenSSH `-o` option whose value lists files (`UserKnownHostsFile`,
 * `GlobalKnownHostsFile`), quoted for both parsers it meets.
 *
 * ssh splits such a value on whitespace itself, so shell quoting alone turns
 * `/tmp/a b/known_hosts` into two files. Each path is wrapped in double quotes
 * for ssh, and the whole option is single-quoted for the `sh -c` that git runs
 * `GIT_SSH_COMMAND` / `core.sshCommand` through. ssh expands a leading `~/`
 * after it splits, so `~/.ssh/known_hosts` still resolves inside the quotes.
 *
 * ssh has no escape for `"` inside a quoted value, so a path containing one is
 * refused rather than mangled.
 */
export function sshFileListOption(option: string, paths: readonly string[]): string {
  for (const path of paths) {
    if (path.includes('"')) {
      throw new Error(`ssh option path must not contain a double quote: ${path}`);
    }
  }
  const value = paths.map((p) => `"${p}"`).join(' ');
  return `-o ${shQuote(`${option}=${value}`)}`;
}
