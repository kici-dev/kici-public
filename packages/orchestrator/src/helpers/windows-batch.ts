/**
 * Running a Windows batch file (`.cmd` / `.bat`) through cmd.exe.
 *
 * Node.js refuses to start a batch file without a shell (it throws `EINVAL`),
 * and every launcher a KiCI package ships on Windows is a batch file. Two
 * callers run one: the service installer, which registers the command with
 * shawl, and the bare-metal scaler, which spawns it.
 *
 * Both quote a token on cmd.exe's command line only when it contains a space
 * or a tab — shawl does, and so does libuv when Node.js builds a Windows
 * command line — so one safety rule fits both.
 */

/**
 * The cmd.exe arguments that run a batch-file launcher, ahead of its path.
 *
 * shawl stops the service with a ctrl-C to its console, and cmd.exe gets it
 * too: when the batch file's node process exits, cmd.exe asks "Terminate batch
 * job (Y/N)?" and waits for an answer. shawl sees the service exit only when its
 * stop timeout kills cmd.exe. With stdin from NUL ({@link BATCH_STDIN}), cmd.exe
 * reads end-of-input at that prompt and exits with node.
 *
 * `call` keeps the launcher path out of the first position after `/c`, where
 * cmd.exe strips the quotes from a path that contains `(`, `)` or `&`. `/e:on`
 * and `/v:off` pin command extensions (the launchers use `%~dp0`) and delayed
 * expansion whatever the host's registry defaults are.
 */
export const BATCH_WRAPPER_ARGS = ['/d', '/e:on', '/v:off', '/c', 'call'] as const;

/** The redirect that closes {@link BATCH_WRAPPER_ARGS}: the launcher's stdin is NUL. */
export const BATCH_STDIN = '<NUL';

/** A `.cmd` or `.bat` file, which Windows runs through cmd.exe. */
export function isBatchFile(executablePath: string): boolean {
  return /\.(cmd|bat)$/i.test(executablePath);
}

/**
 * The cmd.exe that COMSPEC names in `env`, as Node itself uses to run a shell on
 * Windows. A COMSPEC that names another shell is not used: the wrapper
 * arguments are cmd.exe's.
 */
export function cmdExePath(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = env.COMSPEC;
  return comspec && /(^|\\)cmd\.exe$/i.test(comspec) ? comspec : 'C:\\Windows\\System32\\cmd.exe';
}

/**
 * Why cmd.exe would read part of `token` as syntax, or null when it would not.
 *
 * A token is quoted on cmd.exe's command line only when it contains a space or
 * a tab. Inside quotes cmd.exe reads `&`, `|`, `<`, `>`, `(`, `)` and the `,`
 * `;` `=` delimiters as text; outside quotes it reads them as syntax. `%` and
 * `^` change even inside quotes (`call` expands `%` again and doubles `^`), and
 * a `"` ends the quoting.
 *
 * @param use - what the token runs as, completing "cannot run <token> …".
 * @param remedy - the sentence that tells the operator what to change.
 */
export function cmdSafetyRefusal(token: string, use: string, remedy: string): string | null {
  const syntax = /[ \t]/.test(token) ? /["%^]/ : /["%^&|<>(),;=]/;
  const found = syntax.exec(token);
  if (!found) return null;
  return (
    `cannot run "${token}" ${use}: it contains "${found[0]}", which cmd.exe ` +
    `reads as syntax when it runs the batch file. ${remedy}`
  );
}

/** Throw the {@link cmdSafetyRefusal} message for `token`, if it has one. */
export function assertCmdSafe(token: string, use: string, remedy: string): void {
  const refusal = cmdSafetyRefusal(token, use, remedy);
  if (refusal) throw new Error(refusal);
}

/**
 * The cmd.exe command that runs `command` — a batch file and its arguments —
 * with stdin from NUL. The caller checks each token with
 * {@link assertCmdSafe} first.
 */
export function batchFileCommand(
  command: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [cmdExePath(env), ...BATCH_WRAPPER_ARGS, ...command, BATCH_STDIN];
}
