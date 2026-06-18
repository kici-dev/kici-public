/**
 * `kici-admin join` command.
 *
 * Bootstraps a new orchestrator by connecting to an existing cluster via
 * Platform relay or direct peer, receiving an encrypted config bundle, and
 * writing the local YAML config.
 *
 * Usage:
 *   kici-admin join --token kici_join_v1.xxx.yyy --platform wss://platform.kici.dev/ws --api-key KEY
 *   kici-admin join --token kici_join_v1.xxx.yyy --peer https://orch-1:8080
 */

import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { JoinClient } from '../cluster/join-client.js';

export function registerJoinCommand(program: Command): void {
  program
    .command('join')
    .description('Join an existing orchestrator cluster using a join token')
    .requiredOption('--token <token>', 'Join token (kici_join_v1.<routing>.<secret>)')
    .option(
      '--platform <url>',
      'Platform WebSocket URL for relay mode (e.g., wss://platform.kici.dev/ws)',
    )
    .option('--peer <url>', 'Peer HTTP URL for direct mode (e.g., https://orch-1:8080)')
    .option('--api-key <key>', 'API key for Platform authentication (required for --platform mode)')
    .option(
      '--config <path>',
      'Path to write the resulting local config YAML',
      './kici-orchestrator.yaml',
    )
    .action(
      async (opts: {
        token: string;
        platform?: string;
        peer?: string;
        apiKey?: string;
        config: string;
      }) => {
        try {
          const client = new JoinClient({
            token: opts.token,
            platformUrl: opts.platform,
            peerUrl: opts.peer,
            apiKey: opts.apiKey,
            configPath: opts.config,
          });

          await client.join();

          console.log('');
          console.log('Join successful! Next steps:');
          console.log(`  1. Review the config: cat ${opts.config}`);
          console.log('  2. Start the orchestrator: kici-admin orchestrator start');
          console.log('');
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}
