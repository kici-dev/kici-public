/**
 * The variables a `kici-admin` command reads from a service env file it names
 * (`--env-file`): only those `keep` accepts, so an unrelated setting in the
 * file cannot fail the command.
 */
import fs from 'node:fs';
import { toErrorMessage } from '@kici-dev/shared';
import { readEnvValues } from '../../service/backup-timer.js';

/**
 * The variables of the env file at `envFilePath` that `keep` accepts. Throws when the file
 * cannot be read; the message names the path, never the content.
 */
export function envFileVariables(
  envFilePath: string,
  keep: (name: string) => boolean,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): NodeJS.ProcessEnv {
  let content: string;
  try {
    content = readFile(envFilePath);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? toErrorMessage(err);
    throw new Error(`cannot read the env file ${envFilePath} (${reason})`, { cause: err });
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of readEnvValues(content)) {
    if (keep(key)) env[key] = value;
  }
  return env;
}
