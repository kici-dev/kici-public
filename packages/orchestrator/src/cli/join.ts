/**
 * `kici-admin join` command.
 *
 * Bootstraps a new orchestrator by connecting to an existing cluster via
 * Platform relay or direct peer, receiving an encrypted config bundle, and
 * writing an env file the orchestrator boots from.
 *
 * Usage:
 *   kici-admin join --token kici_join_v1.xxx.yyy --platform wss://api.kici.dev/ws --api-key KEY
 *   kici-admin join --token kici_join_v1.xxx.yyy --peer https://orch-1:8080
 */

import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { DEFAULT_JOIN_ENV_FILE, JoinClient } from '../cluster/join-client.js';

export function registerJoinCommand(program: Command): void {
  program
    .command('join')
    .description('Join an existing orchestrator cluster using a join token')
    .requiredOption('--token <token>', 'Join token (kici_join_v1.<routing>.<secret>)')
    .option(
      '--platform <url>',
      'Platform WebSocket URL for relay mode (e.g., wss://api.kici.dev/ws)',
    )
    .option('--peer <url>', 'Peer HTTP URL for direct mode (e.g., https://orch-1:8080)')
    .option('--api-key <key>', 'API key for Platform authentication (required for --platform mode)')
    .option(
      '--env-file <path>',
      `Path to write the env file \`orchestrator install --env-file\` consumes (default: ${DEFAULT_JOIN_ENV_FILE})`,
    )
    .option(
      '--config <path>',
      'Deprecated: write a local config YAML instead. The orchestrator boots from its environment and never reads this file',
    )
    .addHelpText(
      'after',
      `
Token vocabulary:
  A join token (kici_join_v1.<routing>.<secret>) adds this orchestrator as a PEER to
  an existing cluster. For a first, standalone orchestrator you do NOT need a join
  token -- install it with \`kici-admin orchestrator install\` and set
  KICI_PLATFORM_TOKEN to the dashboard REGISTRATION token (kici_ok_...).
`,
    )
    .action(
      async (opts: {
        token: string;
        platform?: string;
        peer?: string;
        apiKey?: string;
        config?: string;
        envFile?: string;
      }) => {
        try {
          const client = new JoinClient({
            token: opts.token,
            platformUrl: opts.platform,
            peerUrl: opts.peer,
            apiKey: opts.apiKey,
            configPath: opts.config,
            envFilePath: opts.envFile,
          });

          await client.join();

          console.log('');
          console.log('Join successful! Next steps:');
          // The notice belongs to the artifact, not to the flag combination:
          // --config writes the YAML whether or not --env-file is also given,
          // so pairing the two used to write the deprecated file in silence.
          if (opts.config) {
            console.error(
              `Warning: --config is deprecated. ${opts.config} is a local YAML the orchestrator never reads; pass --env-file instead.`,
            );
          }
          if (opts.config && !opts.envFile) {
            console.log(`  1. Review the config: cat ${opts.config}`);
            console.log('  2. Start the orchestrator: kici-admin orchestrator start');
          } else {
            const envFile = opts.envFile ?? DEFAULT_JOIN_ENV_FILE;
            console.log(`  1. Review the env file: cat ${envFile}`);
            console.log(
              `  2. Install the service: kici-admin orchestrator install --env-file ${envFile} --mode <mode>`,
            );
            console.log(
              '     The mode has to be chosen here: the install bakes the service entry point',
            );
            console.log(
              '     from it. Set KICI_MODE in the env file first if you prefer, and drop --mode.',
            );
            console.log('  3. Start the orchestrator: kici-admin orchestrator start');
          }
          console.log('');
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}
