#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { Command, Argument, Option, CommanderError } from 'commander';
import pc from 'picocolors';
import { shouldSuppressBanner } from './cli-banner.js';

declare const KICI_VERSION: string;
const version = typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.1';

/**
 * Top-level commands that were removed, mapped to their current equivalent.
 * Consulted when the CLI hits an unknown command so the user gets a precise
 * redirect instead of a bare "unknown command" dead end. The redirect text
 * lives here once; every consumer reads it from this map.
 */
export const RETIRED_COMMANDS: Record<string, string> = {
  status:
    '`kici status` is no longer a command. Use `kici runs list` / ' +
    '`kici runs show <run-id>` to inspect runs, or `kici diagnostics` for ' +
    'orchestrator, scaler, and agent health.',
  cancel: '`kici cancel` is no longer a command. Use `kici runs cancel <run-id>`.',
  'run local':
    '`kici run local` is retired. Every run is now a real routed dispatch — ' +
    'use `kici run <event> --local` (e.g. `kici run push --local`), which runs ' +
    'this machine as an ephemeral agent through the local dev plane.',
};

/**
 * Redirect message for a retired top-level command, or undefined if the name is
 * not a known-retired command.
 */
export function retiredCommandHint(commandName: string | undefined): string | undefined {
  return commandName ? RETIRED_COMMANDS[commandName] : undefined;
}

/**
 * Derive the command name a user attempted from the parsed operands, falling
 * back to the first non-option token in the raw argv. Used to look up a retired
 * command after commander rejects an unknown command.
 */
export function attemptedCommand(program: Command, argv: string[]): string | undefined {
  const firstOperand = program.args[0];
  if (firstOperand) return firstOperand;
  return argv.slice(2).find((token) => !token.startsWith('-'));
}

/**
 * Build the kici Commander program with every command registered. Exported so
 * the surface registry can walk the real command tree without parsing argv (no
 * action runs during a tree walk).
 */
export function buildProgram(): Command {
  const program = new Command();

  program.name('kici').description('KiCI workflow compiler').version(version);
  // `kici run` is action-bearing AND has a `remote` subcommand whose options
  // (`--env`, `--quiet`, `--kici-dir`, `--debug`) collide by name with the
  // parent action's. Positional-options parsing stops the parent from swallowing
  // an option that appears after the subcommand name, so `kici run remote --json`
  // reaches the subcommand instead of the parent.
  program.enablePositionalOptions();

  // Print version header before every command, unless the invocation requested
  // structured (`--json`) or quiet output — stdout must stay parseable then.
  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (shouldSuppressBanner(actionCommand)) return;
    console.log(pc.gray(`kici v${version}`));
  });

  // Configure custom error output
  program.configureOutput({
    outputError: (str, write) => {
      write(pc.red(str));
    },
  });

  // Any unknown command or option ends with a near-match suggestion (when one
  // exists) plus a pointer to the full command list.
  program.showSuggestionAfterError(true);
  program.showHelpAfterError('(run `kici --help` to see all commands)');

  program
    .command('compile')
    .description('Compile workflows from .kici/workflows/ to kici.lock.json')
    .option(
      '--check',
      'Validate workflows and type-check sources (tsc --noEmit) without writing lock file',
      false,
    )
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option('--verbose', 'Detailed output', false)
    .option('--watch', 'Watch for changes and recompile', false)
    .action(async (options) => {
      const { compileCommand, watchCommand } = await import('./commands/index.js');
      if (options.watch) {
        // Watch mode - runs indefinitely
        await watchCommand({
          kiciDir: options.kiciDir,
          verbose: options.verbose,
        });
        // watchCommand handles its own exit
      } else {
        // Single compilation
        const success = await compileCommand({
          kiciDir: options.kiciDir,
          check: options.check,
          verbose: options.verbose,
        });
        process.exit(success ? 0 : 1);
      }
    });

  const fixtureEventArg = new Argument(
    '<event>',
    'Event to generate fixture for (e.g., pr:open, push, schedule, lifecycle:workflow_complete)',
  );

  program
    .command('fixture')
    .addArgument(fixtureEventArg)
    .description('Generate fixture template for event type')
    .option('--output <path>', 'Write to file instead of stdout')
    .action(async (event, options) => {
      const { fixtureCommand } = await import('./commands/index.js');
      await fixtureCommand(event, options);
    });

  // --- kici run (local and remote subcommands) ---

  const runCommand = program.command('run').description('Execute workflows locally or remotely');
  // Route options after the `remote` subcommand name to the subcommand (see the
  // program-level note above) rather than the parent action.
  runCommand.enablePositionalOptions();

  // `kici run [event]` is action-bearing: a routed run with this machine as the
  // ephemeral agent, dispatched through the warm local dev plane. It coexists
  // with the `run remote` subcommand below — Commander dispatches to `remote`
  // when the first token matches, else runs this parent action. The retired
  // `run local` subcommand redirects here via the action's retired-command guard.
  runCommand
    .argument('[event]', 'Event type for a routed local run (e.g. push, pr:open)')
    .option('--local', 'Route the run with this machine as the ephemeral agent', false)
    .option('--offline', 'Force the throwaway/independent plane (offline)', false)
    .option('--connected', 'Force the connected/hybrid plane (requires attachment)', false)
    .option('--in-place', 'Reuse the working tree directly instead of an isolated clone', false)
    .option(
      '--trusted',
      'Route to the trusted fleet agent profile: steps see the ambient host env (minus the agent identity). Alias: --no-sandbox',
      false,
    )
    .option('--no-sandbox', 'Alias for --trusted (the bwrap sandbox is already off by default)')
    .option(
      '--env <KEY=VALUE>',
      'Per-run secret (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--payload <path>',
      'Dispatch payload JSON { action?, client_payload? } for a routed dispatch run',
    )
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option('--quiet', 'Suppress the banner + streaming output', false)
    .option('--debug', 'Verbose internals', false)
    .action(async (event, options) => {
      // `kici run local` reaches this parent action (event === 'local') now that
      // the `local` subcommand is retired; redirect to the routed replacement.
      const retired = retiredCommandHint(event ? `run ${event}` : undefined);
      if (retired) {
        process.stderr.write(pc.red(`${retired}\n`));
        process.exit(2);
      }
      const { runRoutedCommand } = await import('./commands/index.js');
      const success = await runRoutedCommand({
        event,
        local: options.local,
        offline: options.offline,
        connected: options.connected,
        inPlace: options.inPlace,
        // `--trusted` or its alias `--no-sandbox` (Commander sets options.sandbox
        // === false when `--no-sandbox` is passed) select the trusted profile.
        trusted: Boolean(options.trusted) || options.sandbox === false,
        env: options.env,
        payload: options.payload,
        kiciDir: options.kiciDir,
        quiet: options.quiet,
        debug: options.debug,
      });
      process.exit(success ? 0 : 1);
    });

  runCommand
    .command('remote')
    .argument('[fixture]', 'Fixture name or glob pattern (omit to list available)')
    .description('Execute fixtures remotely via orchestrator')
    .option('--workflow <name>', 'Run a specific workflow directly (bypass triggers)')
    .option('--all', 'Run all available fixtures', false)
    .option('-p, --pick', 'Interactively pick fixtures to run', false)
    .option('--parallel', 'Run matching fixtures concurrently', false)
    .option('--no-wait', "Fire and forget (print runIds, don't stream)")
    .option('--quiet', 'Suppress output except final result', false)
    .option('--json', 'Output structured JSON result', false)
    .option('--junit <path>', 'Output JUnit XML result')
    .option('--history', 'Show recent run history', false)
    .option('--routing-key <key>', 'Override routing key for this run')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .option('--orchestrator <name>', 'Target orchestrator cluster (overrides the per-org default)')
    .option('--debug', 'Verbose internals', false)
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option(
      '--context <ctx.key=value>',
      'Inject a namespaced context secret, uploaded encrypted to the orchestrator (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--env <KEY=VALUE>',
      'Provide a per-run secret (repeatable); uploaded encrypted to the orchestrator',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--check', 'Run in check mode: report drift, change nothing', false)
    .option('--fail-on-drift', 'In check mode, exit non-zero if any step reports drift', false)
    .option(
      '--target <selector>',
      'Narrow runsOnAll jobs to hosts matching this label selector (repeatable, AND-combined)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--target-allow-empty',
      'A --target that narrows a runsOnAll job to zero hosts skips it instead of failing',
      false,
    )
    .option(
      '--input <KEY=VALUE>',
      'Typed workflow-dispatch input (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      // `--yes` is listed first so Commander derives the option property from
      // the last long flag (`--approve-all` → `options.approveAll`); both flags
      // remain accepted aliases.
      '--yes, --approve-all',
      'Auto-approve every approval gate this run holds on (run-scoped; eligibility still enforced)',
      false,
    )
    .action(async (fixture, options) => {
      if (options.pick && fixture) {
        console.error(
          'Error: --pick selects fixtures interactively; do not also pass a fixture name.',
        );
        process.exit(2);
      }
      if (options.pick && options.all) {
        console.error('Error: --pick is mutually exclusive with --all.');
        process.exit(2);
      }
      if (options.pick && options.workflow) {
        console.error('Error: --pick is mutually exclusive with --workflow.');
        process.exit(2);
      }
      const { runRemoteCommand } = await import('./commands/index.js');
      const { resolveCheckMode } = await import('./commands/check-mode.js');
      let checkMode;
      try {
        checkMode = resolveCheckMode({ check: options.check, failOnDrift: options.failOnDrift });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
      const success = await runRemoteCommand(fixture, {
        ...options,
        checkMode,
        envFlags: options.env,
        targets: options.target,
        targetAllowEmpty: options.targetAllowEmpty,
        approveAll: options.approveAll,
        inputs: options.input,
      });
      process.exit(success ? 0 : 1);
    });

  // --- kici preview (dry-run trigger preview only) ---

  program
    .command('preview')
    .argument('[event]', 'Event type to preview (e.g., push, pr:open, schedule)')
    .description('Preview which workflows match a trigger event (no execution)')
    .option('--branch <name>', 'Override target branch for trigger matching (default: main)')
    .option('--sha <hash>', 'Override commit SHA')
    .option('--workflow <name>', 'Filter to specific workflow in display')
    .option('--job <name>', 'Filter to specific job in display')
    .option('--debug', 'Verbose internals', false)
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .option(
      '--files <path>',
      'Simulate changed file path for trigger matching (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--secret <key=value>',
      'Inject flat secret (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--context <ctx.key=value>',
      'Inject context secret (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .action(async (event, options) => {
      const { previewCommand } = await import('./commands/index.js');
      const success = await previewCommand(event, options);
      process.exit(success ? 0 : 1);
    });

  program
    .command('init')
    .description('Initialize .kici/ directory with default workflows')
    .option('--force', 'Overwrite existing .kici/ directory', false)
    .option('--skip-install', 'Create files without installing dependencies', false)
    .option(
      '--package-manager <npm|pnpm|yarn>',
      'Force a package manager for the install step (default: auto-detect)',
    )
    .option('--mjs', 'JavaScript-only mode (no TypeScript, no dependencies)', false)
    .option(
      '--workspace',
      'Integrate .kici/ into the detected pnpm/npm/yarn workspace so workflows can import sibling packages',
      false,
    )
    .option('--standalone', 'Force a self-contained .kici/ even inside a workspace', false)
    .option('--no-agents-md', 'Skip writing .kici/AGENTS.md (LLM authoring context)')
    .option('--private-registry <url>', 'Scaffold a workflow registries: entry pointing at <url>')
    .option(
      '--private-registry-scope <scope>',
      'Optional npm package scope (e.g. @my-org) for the private registry',
    )
    .option(
      '--private-registry-secret <ref>',
      'Qualified secret reference (env:NAME) the private registry token comes from',
      'production:NPM_TOKEN',
    )
    .addOption(new Option('--use-verdaccio-local').default(false).hideHelp())
    .action(async (options) => {
      const { initCommand } = await import('./commands/index.js');
      // commander turns `--no-agents-md` into options.agentsMd=false when the flag
      // is passed (true by default). Translate to the InitOptions field shape.
      const success = await initCommand({
        ...options,
        noAgentsMd: options.agentsMd === false,
      });
      process.exit(success ? 0 : 1);
    });

  const hookCommand = program.command('hook').description('Manage pre-commit hooks');

  hookCommand
    .command('install')
    .description('Install kici compile pre-commit hook')
    .option('--git', 'Use raw git hook (.git/hooks/pre-commit)', false)
    .action(async (options) => {
      const { hookInstallCommand } = await import('./commands/index.js');
      const success = await hookInstallCommand({
        git: options.git,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('login')
    .description('Authenticate with KiCI via browser OAuth (default) or API key (--token)')
    .option('--token <key>', 'API key for direct authentication (legacy)')
    .option('--device', 'Force device authorization flow (for headless/SSH environments)')
    .option('--platform-endpoint <url>', 'Platform relay URL')
    .option(
      '--oidc-issuer <url>',
      'OIDC issuer URL (defaults to the hosted KiCI IdP unless a flag/env selects another)',
    )
    .option('--routing-key <key>', 'Routing key for webhook source identification')
    .option('--no-attach', 'Skip the post-login prompt to attach the local dev plane')
    .addHelpText(
      'after',
      `
Environment variables:
  KICI_BROWSER_CMD     Custom browser command (use {url} placeholder, or 'none' to suppress)
  KICI_CALLBACK_PORT   Fixed port for OAuth PKCE callback server (default: random)
  KICI_CONFIG_DIR      Override config directory (default: ~/.kici)
  KICI_OIDC_ISSUER     Override OIDC issuer URL
  KICI_OIDC_CLIENT_ID  Override OIDC client ID
`,
    )
    .action(async (options) => {
      const { loginCommand } = await import('./commands/index.js');
      const success = await loginCommand({
        token: options.token,
        device: options.device,
        platformEndpoint: options.platformEndpoint,
        oidcIssuer: options.oidcIssuer,
        routingKey: options.routingKey,
        // Commander sets options.attach=false for --no-attach (default true).
        noAttachPrompt: options.attach === false,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('logout')
    .description('Revoke PAT and clear local credentials')
    .action(async () => {
      const { logoutCommand } = await import('./commands/index.js');
      const success = await logoutCommand();
      process.exit(success ? 0 : 1);
    });

  const orgCommand = program.command('org').description('Manage organizations');

  orgCommand
    .command('list')
    .description('List organizations you belong to')
    .action(async () => {
      const { orgListCommand } = await import('./commands/index.js');
      const success = await orgListCommand();
      process.exit(success ? 0 : 1);
    });

  orgCommand
    .command('use')
    .argument('<name>', 'Organization name or ID')
    .description('Switch active organization')
    .action(async (name) => {
      const { orgUseCommand } = await import('./commands/index.js');
      const success = await orgUseCommand(name);
      process.exit(success ? 0 : 1);
    });

  orgCommand
    .command('current')
    .description('Show current active organization')
    .action(async () => {
      const { orgCurrentCommand } = await import('./commands/index.js');
      const success = await orgCurrentCommand();
      process.exit(success ? 0 : 1);
    });

  const orchestratorsCommand = program
    .command('orchestrators')
    .description("Inspect the org's orchestrator clusters and pick a default for run remote");

  orchestratorsCommand
    .command('list')
    .description('List the connected orchestrator clusters for the active org')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (options) => {
      const { orchestratorsListCommand } = await import('./commands/index.js');
      const success = await orchestratorsListCommand({ org: options.org });
      process.exit(success ? 0 : 1);
    });

  orchestratorsCommand
    .command('use')
    .argument('<name>', 'Orchestrator cluster name')
    .description('Set the per-org default orchestrator cluster for run remote')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (name, options) => {
      const { orchestratorsUseCommand } = await import('./commands/index.js');
      const success = await orchestratorsUseCommand(name, { org: options.org });
      process.exit(success ? 0 : 1);
    });

  const notificationsCommand = program
    .command('notifications')
    .description("Manage the org's notification channels, subscriptions, and Slack roster");

  const notificationsChannels = notificationsCommand
    .command('channels')
    .description('Manage notification channels (Slack / email)');
  notificationsChannels
    .command('list')
    .description('List notification channels')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { notificationsChannelsListCommand } = await import('./commands/index.js');
      const ok = await notificationsChannelsListCommand({ org: options.org, json: options.json });
      process.exit(ok ? 0 : 1);
    });
  notificationsChannels
    .command('add')
    .description('Add a notification channel')
    .requiredOption('--type <slack|email>', 'Channel transport type')
    .requiredOption('--name <name>', 'Channel display name')
    .option('--connection <id>', 'Slack connection id (slack channels)')
    .option('--slack-channel <id>', 'Slack channel id (slack channels)')
    .option('--from-name <name>', 'Sender name (email channels)')
    .option('--reply-to <email>', 'Reply-to address (email channels)')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (options) => {
      const { notificationsChannelsAddCommand } = await import('./commands/index.js');
      const ok = await notificationsChannelsAddCommand({
        org: options.org,
        type: options.type,
        name: options.name,
        connection: options.connection,
        slackChannel: options.slackChannel,
        fromName: options.fromName,
        replyTo: options.replyTo,
      });
      process.exit(ok ? 0 : 1);
    });
  notificationsChannels
    .command('remove')
    .argument('<id>', 'Channel id')
    .description('Remove a notification channel')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (id, options) => {
      const { notificationsChannelsRemoveCommand } = await import('./commands/index.js');
      const ok = await notificationsChannelsRemoveCommand(id, { org: options.org });
      process.exit(ok ? 0 : 1);
    });

  const notificationsSubscriptions = notificationsCommand
    .command('subscriptions')
    .description('Manage notification subscriptions');
  notificationsSubscriptions
    .command('list')
    .description('List notification subscriptions')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { notificationsSubscriptionsListCommand } = await import('./commands/index.js');
      const ok = await notificationsSubscriptionsListCommand({
        org: options.org,
        json: options.json,
      });
      process.exit(ok ? 0 : 1);
    });
  notificationsSubscriptions
    .command('add')
    .description('Add a notification subscription')
    .requiredOption('--channel <id>', 'Target channel id')
    .requiredOption('--on-status <csv>', 'Statuses to notify on (e.g. failed,success)')
    .option('--level <run|job>', 'Subscription granularity', 'run')
    .option('--scope <org|team|user|actor>', 'Subscription scope', 'org')
    .option('--scope-id <id>', 'Scope id (required for team/user scope)')
    .option('--repo-glob <glob>', 'Match runs whose repo matches this glob')
    .option('--workflow-glob <glob>', 'Match runs whose workflow matches this glob')
    .option('--job-glob <glob>', 'Match jobs matching this glob (job level)')
    .option('--mentions <csv>', 'Literal Slack member/group ids or emails to mention')
    .option('--recipient-override <csv>', 'Override the email recipient set')
    .option('--on-failure-class <csv>', 'Only match these failure classes')
    .option('--accumulate-for <ms>', 'Digest accumulation window in milliseconds')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (options) => {
      const { notificationsSubscriptionsAddCommand } = await import('./commands/index.js');
      const ok = await notificationsSubscriptionsAddCommand({
        org: options.org,
        channel: options.channel,
        onStatus: options.onStatus,
        level: options.level,
        scope: options.scope,
        scopeId: options.scopeId,
        repoGlob: options.repoGlob,
        workflowGlob: options.workflowGlob,
        jobGlob: options.jobGlob,
        mentions: options.mentions,
        recipientOverride: options.recipientOverride,
        onFailureClass: options.onFailureClass,
        accumulateFor: options.accumulateFor,
      });
      process.exit(ok ? 0 : 1);
    });
  notificationsSubscriptions
    .command('remove')
    .argument('<id>', 'Subscription id')
    .description('Remove a notification subscription')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (id, options) => {
      const { notificationsSubscriptionsRemoveCommand } = await import('./commands/index.js');
      const ok = await notificationsSubscriptionsRemoveCommand(id, { org: options.org });
      process.exit(ok ? 0 : 1);
    });

  const notificationsRoster = notificationsCommand
    .command('roster')
    .description('Manage the Layer 1 Slack-identity roster (actor tagging)');
  notificationsRoster
    .command('list')
    .description('List Slack-identity roster entries')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { notificationsRosterListCommand } = await import('./commands/index.js');
      const ok = await notificationsRosterListCommand({ org: options.org, json: options.json });
      process.exit(ok ? 0 : 1);
    });
  notificationsRoster
    .command('add')
    .description('Add a Slack-identity roster entry')
    .requiredOption('--connection <id>', 'Slack connection id')
    .requiredOption('--subject-kind <kici_user|git_login|email>', 'What the subject keys on')
    .requiredOption('--subject <value>', 'The KiCI user sub, git login, or email')
    .requiredOption('--value <slackIdEmailOrHandle>', 'Slack member id, email, or @handle')
    .option('--input-form <id|username|email>', 'How --value should be resolved', 'id')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (options) => {
      const { notificationsRosterAddCommand } = await import('./commands/index.js');
      const ok = await notificationsRosterAddCommand({
        org: options.org,
        connection: options.connection,
        subjectKind: options.subjectKind,
        subject: options.subject,
        inputForm: options.inputForm,
        value: options.value,
      });
      process.exit(ok ? 0 : 1);
    });
  notificationsRoster
    .command('remove')
    .argument('<id>', 'Roster entry id')
    .description('Remove a Slack-identity roster entry')
    .option('--org <id>', 'Target organization (overrides the active org)')
    .action(async (id, options) => {
      const { notificationsRosterRemoveCommand } = await import('./commands/index.js');
      const ok = await notificationsRosterRemoveCommand(id, { org: options.org });
      process.exit(ok ? 0 : 1);
    });

  const localCommand = program
    .command('local')
    .description('Manage the local dev orchestrator plane');
  localCommand
    .command('up')
    .description('Start (or reuse) the local dev plane')
    .option(
      '--offline',
      'Force the independent (offline) plane (does not clear the attachment record)',
      false,
    )
    .option(
      '--connected',
      'Force the connected/hybrid plane (requires an attached, reachable Platform)',
      false,
    )
    .action(async (options: { offline?: boolean; connected?: boolean }) => {
      const { localUpCommand } = await import('./commands/index.js');
      const ok = await localUpCommand({ offline: options.offline, connected: options.connected });
      process.exit(ok ? 0 : 1);
    });
  localCommand
    .command('status')
    .description('Show local dev plane status and control commands')
    .option('--json', 'Emit machine-readable JSON (exits 0 for every state)', false)
    .action(async (options: { json?: boolean }) => {
      const { localStatusCommand } = await import('./commands/index.js');
      const ok = await localStatusCommand({ json: options.json });
      process.exit(ok ? 0 : 1);
    });
  for (const [name, desc, fn] of [
    ['down', 'Stop the local dev plane', 'localDownCommand'],
    ['logs', 'Print the local dev plane orchestrator log path', 'localLogsCommand'],
    ['attach', 'Attach the local dev plane to the Platform (hybrid)', 'localAttachCommand'],
    ['detach', 'Detach the local dev plane from the Platform (offline)', 'localDetachCommand'],
  ] as const) {
    localCommand
      .command(name)
      .description(desc)
      .action(async () => {
        const cmds = await import('./commands/index.js');
        const ok = await (cmds as unknown as Record<string, () => Promise<boolean>>)[fn]();
        process.exit(ok ? 0 : 1);
      });
  }
  localCommand
    .command('trust-root')
    .description('Export the offline dev-signed identity trust root ({ issuer, jwks }) to a file')
    .argument('<file>', 'Output path for the { issuer, jwks } trust-root JSON')
    .action(async (file: string) => {
      const { localTrustRootCommand } = await import('./commands/index.js');
      const ok = await localTrustRootCommand(file);
      process.exit(ok ? 0 : 1);
    });

  const secretsCommand = program.command('secrets').description('Manage secrets');

  secretsCommand
    .command('list')
    .description('List test-available secret contexts')
    .action(async () => {
      const { secretsListCommand } = await import('./commands/index.js');
      const success = await secretsListCommand();
      process.exit(success ? 0 : 1);
    });

  const patCommand = program.command('pat').description('Manage personal access tokens');

  patCommand
    .command('create')
    .description('Mint a personal access token (use --agent for a coding-agent token)')
    .option('--name <name>', 'Token name (defaults to the agent label)')
    .option('--agent', 'Mint an agent-kind PAT for the KiCI MCP server', false)
    .option('--expires-in-days <n>', 'Custom expiry in days', (v) => parseInt(v, 10))
    .action(async (options) => {
      const { patCreateCommand } = await import('./commands/index.js');
      const success = await patCreateCommand({
        name: options.name,
        agent: options.agent,
        label: options.name,
        expiresInDays: options.expiresInDays,
      });
      process.exit(success ? 0 : 1);
    });

  const runsCommand = program.command('runs').description('Inspect and manage execution runs');

  runsCommand
    .command('list')
    .description('List execution runs (mirrors the dashboard Runs page)')
    .option('--status <s>', 'Filter by status')
    .option('--workflow <w>', 'Filter by workflow name')
    .option('--branch <b>', 'Filter by branch/ref')
    .option('--repo <r>', 'Filter by repository')
    .option('--trigger <t>', 'Filter by trigger type')
    .option('--source <routingKey>', 'Filter by source routing key')
    .option('--since <ts>', 'Only runs since (ISO-8601 or epoch ms)')
    .option('--cursor <cursor>', 'Keyset cursor for the next page (from a prior nextCursor)')
    .option('--json', 'Output raw JSON', false)
    .action(async (options) => {
      const { runsListCommand } = await import('./commands/index.js');
      const success = await runsListCommand(options);
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('show')
    .argument('<run-id>', 'Run ID to inspect')
    .description('Show a run summary with its jobs and steps')
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsShowCommand } = await import('./commands/index.js');
      const success = await runsShowCommand(runId, { json: options.json });
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('logs')
    .argument('<run-id>', 'Run ID')
    .description('Print step logs for a run')
    .option('--job <name>', 'Only logs for this job')
    .option('-f, --follow', 'Tail logs for a live run', false)
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsLogsCommand } = await import('./commands/index.js');
      const success = await runsLogsCommand(runId, {
        job: options.job,
        follow: options.follow,
        json: options.json,
      });
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('rerun')
    .argument('<run-id>', 'Run ID to rerun')
    .description('Re-trigger a run')
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsRerunCommand } = await import('./commands/index.js');
      const success = await runsRerunCommand(runId, { json: options.json });
      process.exit(success ? 0 : 1);
    });

  runsCommand
    .command('cancel')
    .argument('[run-id]', 'Run ID to cancel')
    .description('Cancel a run, or all in-progress runs on a branch')
    .option('--force', 'Force cancel (kill immediately, skip hooks)', false)
    .option('--branch <name>', 'Cancel all in-progress runs on this branch')
    .action(async (runId, options) => {
      const { runsCancelCommand } = await import('./commands/index.js');
      const success = await runsCancelCommand(runId, {
        force: options.force,
        branch: options.branch,
      });
      process.exit(success ? 0 : 1);
    });

  const runsArtifacts = runsCommand
    .command('artifacts')
    .description("List and download a run's artifacts");

  runsArtifacts
    .command('list')
    .argument('<run-id>', 'Run ID whose artifacts to list')
    .description('List the artifacts a run uploaded')
    .option('--json', 'Output raw JSON', false)
    .action(async (runId, options) => {
      const { runsArtifactsListCommand } = await import('./commands/index.js');
      const success = await runsArtifactsListCommand(runId, { json: options.json });
      process.exit(success ? 0 : 1);
    });

  runsArtifacts
    .command('download')
    .argument('<run-id>', 'Run ID whose artifacts to download')
    .argument('[name]', 'Artifact name (omit to download every artifact of the run)')
    .description('Download one artifact, or all of them — extracts by default')
    .option('--archive', 'Save the raw .tar.gz instead of extracting', false)
    .option('-o, --output <dir>', 'Output directory (default: current directory)')
    .action(async (runId, name, options) => {
      const { runsArtifactsDownloadCommand } = await import('./commands/index.js');
      const success = await runsArtifactsDownloadCommand(runId, name, {
        archive: options.archive,
        output: options.output,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('approve')
    .argument('<run-id>', 'Run ID whose approval gate to approve')
    .description('Approve a held approval gate for a run')
    .option('--job <name>', 'Approve the hold for a specific job')
    .option('--step <index>', 'Approve a step-scoped hold (requires --job)')
    .action(async (runId, options) => {
      const { approveCommand } = await import('./commands/index.js');
      const success = await approveCommand(runId, {
        job: options.job,
        step: options.step,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('reject')
    .argument('<run-id>', 'Run ID whose approval gate to reject')
    .description('Reject a held approval gate for a run')
    .option('--job <name>', 'Reject the hold for a specific job')
    .option('--step <index>', 'Reject a step-scoped hold (requires --job)')
    .requiredOption('--reason <text>', 'Reason for the rejection')
    .action(async (runId, options) => {
      const { rejectCommand } = await import('./commands/index.js');
      const success = await rejectCommand(runId, {
        job: options.job,
        step: options.step,
        reason: options.reason,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('types')
    .description('Generate TypeScript declarations for secret contexts')
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .action(async (options) => {
      const { typesCommand } = await import('./commands/index.js');
      const success = await typesCommand({
        kiciDir: options.kiciDir,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('endpoints')
    .description('List all webhook entrypoints for the current project')
    .option('--kici-dir <path>', 'Path to .kici directory', '.kici')
    .action(async (options) => {
      const { endpointsCommand } = await import('./commands/index.js');
      const success = await endpointsCommand({
        kiciDir: options.kiciDir,
      });
      process.exit(success ? 0 : 1);
    });

  program
    .command('doctor')
    .description('Diagnose your KiCI setup and print the exact next command for each problem')
    .option('--json', 'Output raw JSON instead of a table', false)
    .option('--kici-dir <path>', 'Path to the .kici directory', '.kici')
    .action(async (options) => {
      const { doctorCommand } = await import('./commands/index.js');
      const exitCode = await doctorCommand({ json: options.json, kiciDir: options.kiciDir });
      process.exit(exitCode);
    });

  program
    .command('diagnostics')
    .description(
      'Show orchestrators, scalers, and agents (mirrors the dashboard Infrastructure page)',
    )
    .option('--json', 'Output raw JSON', false)
    .option('--verbose', 'Show extended per-agent fields', false)
    .option('--orchestrator <id>', 'Scope the tree to one connection id')
    .action(async (options) => {
      const { diagnosticsCommand } = await import('./commands/index.js');
      const success = await diagnosticsCommand({
        json: options.json,
        verbose: options.verbose,
        orchestrator: options.orchestrator,
      });
      process.exit(success ? 0 : 1);
    });

  const workflowsCommand = program
    .command('workflows')
    .description('Manage workflow registrations');

  workflowsCommand
    .command('list')
    .description('List permanently registered workflows')
    .option('--json', 'Output as JSON', false)
    .option('--stale <duration>', 'Filter stale registrations (e.g., 30d, 7d)')
    .option('--trigger-type <type>', 'Filter by trigger type')
    .option('--repo <repo>', 'Filter by repository')
    .action(async (options) => {
      const { workflowsListCommand } = await import('./commands/index.js');
      const success = await workflowsListCommand({
        json: options.json,
        stale: options.stale,
        triggerType: options.triggerType,
        repo: options.repo,
      });
      process.exit(success ? 0 : 1);
    });

  // --- kici docs (open docs site + print bundled LLM context) ---

  const docsCommandGroup = program
    .command('docs')
    .description('Open the KiCI documentation site in the default browser')
    .option('--no-open', 'Print the docs URL instead of opening a browser')
    .action(async (options) => {
      const { docsCommand } = await import('./commands/index.js');
      const success = await docsCommand({ open: options.open });
      process.exit(success ? 0 : 1);
    });

  docsCommandGroup
    .command('llm [topic]')
    .description(
      'Print KiCI LLM docs bundles. No topic prints the llms.txt index; <topic> prints a task bundle (e.g. sdk, cli, patterns, features, providers, architecture, getting-started); "full" prints the complete bundle.',
    )
    .option('--out <path>', 'Write the bundle to a file instead of stdout')
    .action(async (topic, options) => {
      const { docsLlmCommand } = await import('./commands/index.js');
      const success = await docsLlmCommand({ topic, out: options.out });
      process.exit(success ? 0 : 1);
    });

  // --- kici admin (operator-facing commands) ---

  const adminCommand = program
    .command('admin')
    .description('Operator-facing commands for running instances');

  adminCommand
    .command('drain-worker')
    .description('Trigger graceful drain on a worker instance')
    .requiredOption('--url <url>', 'Worker URL (e.g., http://worker-host:<port>)')
    .action(async (options) => {
      const { drainWorkerCommand } = await import('./commands/index.js');
      const success = await drainWorkerCommand({ url: options.url });
      process.exit(success ? 0 : 1);
    });

  program
    .command('verify-attestation')
    .argument(
      '[artifact]',
      'Artifact path to digest-check against the attestation subject (optional)',
    )
    .description('Verify a KiCI provenance attestation bundle offline')
    .option('--bundle <path>', 'Path or URL to the attestation bundle JSON')
    .option(
      '--trust-root <url-or-file>',
      'Trusted issuer URL, or a self-contained { issuer, jwks } file (default: your configured orchestrator, else the hosted KiCI platform)',
    )
    .option('--audience <aud>', 'Expected token audience')
    .option('--json', 'Output structured JSON result', false)
    .action(async (artifact, options) => {
      const { verifyAttestationCommand } = await import('./commands/index.js');
      const success = await verifyAttestationCommand(artifact, options);
      process.exit(success ? 0 : 1);
    });

  return program;
}

/**
 * Handle a commander parse exit thrown under `exitOverride`. Help and version
 * requests exit cleanly; an unknown command is augmented with a retired-command
 * redirect when one applies (commander already wrote the generic error,
 * suggestion, and help pointer before throwing); every other parse error keeps
 * commander's own exit code and already-printed message.
 */
function handleCliParseExit(err: CommanderError, argv: string[], program: Command): void {
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
    process.exit(0);
  }
  if (err.code === 'commander.unknownCommand') {
    const hint = retiredCommandHint(attemptedCommand(program, argv));
    if (hint) process.stderr.write(pc.red(`${hint}\n`));
  }
  process.exit(err.exitCode ?? 1);
}

/** Build the program and parse argv — the bin-shim entry point. */
export function runCli(argv: string[] = process.argv): void {
  const program = buildProgram();
  program.exitOverride();
  try {
    program.parse(argv);
  } catch (err) {
    handleCliParseExit(err as CommanderError, argv, program);
  }
}

/**
 * Decide whether this module is the process entry point, tolerating a
 * symlinked `argv[1]`. A `node_modules/.bin/kici` entry is a symlink, and when
 * it points at this compiled `cli.js` (the compiler package declares a `kici`
 * bin), `process.argv[1]` is the symlink path while `import.meta.url` is the
 * real file. A plain `resolve()` comparison sees two different paths and never
 * matches, silently skipping `runCli()` — so `kici compile` (and every other
 * subcommand) becomes a no-op when invoked through the bin symlink.
 * Dereference both sides with `realpathSync` so a symlinked invocation is
 * correctly recognised as the entry point. Falls back to a plain `resolve()`
 * comparison when `argv[1]` doesn't resolve to a real file (e.g. a virtual
 * entry point), preserving the previous behaviour for that edge case.
 */
export function isMainEntryPoint(argv1: string | undefined, importMetaUrl: string): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return resolve(argv1) === resolve(modulePath);
  }
}

// Only parse argv when this module is the process entry point. The published
// bin shim imports `runCli` and calls it explicitly; importing the module
// (e.g. the surface registry building the command tree) must NOT parse/exit.
if (isMainEntryPoint(process.argv[1], import.meta.url)) {
  runCli();
}
