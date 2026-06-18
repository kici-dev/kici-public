/**
 * Programmatic nftables rule management for agent network isolation.
 *
 * Manages RFC1918 + cloud metadata blocking rules per-interface (Firecracker/container)
 * or per-UID (bare-metal). All operations use `nft` CLI via child_process.execFile.
 *
 * Table layout:
 *   table ip kici {
 *     chain forward { type filter hook forward priority 0; policy accept; }
 *     chain output  { type filter hook output priority 0; policy accept; }
 *   }
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { NetworkPolicy } from './types.js';

/**
 * Match mode for nftables isolation rules.
 * - 'iifname': Match on input interface name (Firecracker TAP devices)
 * - 'saddr': Match on source IP address (container backends)
 */
export type NftMatchMode = 'iifname' | 'saddr';

const execFile = promisify(execFileCb);
const logger = createLogger({ prefix: 'nftables' });

/** Timeout for nft commands in milliseconds. */
const NFT_TIMEOUT_MS = 10_000;

/** RFC1918 private address ranges. */
export const RFC1918_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

/** Cloud metadata service range (AWS/GCP/Azure link-local). */
export const METADATA_RANGE = '169.254.0.0/16';

/**
 * Options for nft command execution.
 */
interface NftOptions {
  /**
   * Wrap the `nft` invocation with `sudo -n` so non-root orchestrators (e.g.
   * Pi user-mode systemd) can manage rules. Operators must have a NOPASSWD
   * sudoers entry for /usr/sbin/nft. Default false.
   */
  requireSudo?: boolean;
}

/**
 * Execute an nft command with timeout.
 * @returns stdout from the command
 * @throws Error on non-zero exit or timeout
 */
async function nft(opts: NftOptions, ...args: string[]): Promise<string> {
  const useSudo = opts.requireSudo === true;
  const { stdout } = useSudo
    ? await execFile('sudo', ['-n', 'nft', ...args], { timeout: NFT_TIMEOUT_MS })
    : await execFile('nft', args, { timeout: NFT_TIMEOUT_MS });
  return stdout;
}

/**
 * Validate that nftables is available and the process has NET_ADMIN capability.
 * Attempts `nft list tables` -- if it fails:
 *   - ENOENT: nft binary not installed
 *   - EPERM: nft binary present but NET_ADMIN capability missing
 * Throws with a clear error message in both cases.
 */
export async function validateNftablesAvailability(opts: NftOptions = {}): Promise<void> {
  try {
    await nft(opts, 'list', 'tables');
  } catch (err) {
    const message = toErrorMessage(err);
    if (message.includes('ENOENT') || message.includes('not found')) {
      throw new Error(
        'nftables binary not found at /usr/sbin/nft. ' +
          'The orchestrator container image must include nftables (apk add nftables). ' +
          'Network isolation for agents cannot be established without nftables.',
      );
    }
    if (message.includes('EPERM') || message.includes('Operation not permitted')) {
      throw new Error(
        'nftables operation denied -- missing NET_ADMIN capability. ' +
          'Start the orchestrator container with --cap-add=NET_ADMIN. ' +
          'Network isolation for agents requires this capability.',
      );
    }
    throw new Error(`nftables validation failed: ${message}`);
  }
}

/**
 * Ensure the `kici` nftables table and required chains exist.
 * Idempotent -- safe to call multiple times.
 */
export async function ensureKiciTable(opts: NftOptions = {}): Promise<void> {
  try {
    await nft(opts, 'list', 'table', 'ip', 'kici');
    logger.debug('kici nftables table already exists');
    return;
  } catch {
    // Table doesn't exist yet, create it
  }

  logger.info('Creating kici nftables table with forward and output chains');

  // Create table and chains atomically via nft -f with heredoc-style input
  await nft(
    opts,
    '-f',
    '/dev/stdin',
    // The actual ruleset is passed via stdin by execFile
  ).catch(() => {
    // fallback: create individually
  });

  // Create table
  await nft(opts, 'add', 'table', 'ip', 'kici');

  // Create forward chain (for interface-based filtering: Firecracker, containers)
  try {
    await nft(
      opts,
      'add',
      'chain',
      'ip',
      'kici',
      'forward',
      '{ type filter hook forward priority 0; policy accept; }',
    );
  } catch {
    logger.debug('kici forward chain already exists');
  }

  // Create output chain (for UID-based filtering: bare-metal)
  try {
    await nft(
      opts,
      'add',
      'chain',
      'ip',
      'kici',
      'output',
      '{ type filter hook output priority 0; policy accept; }',
    );
  } catch {
    logger.debug('kici output chain already exists');
  }

  logger.info('kici nftables table and chains created');
}

/** A single nft rule operation: the verb decides chain placement. */
export interface NftRuleOp {
  /** 'insert' prepends to the chain head; 'add' appends to the tail. */
  verb: 'insert' | 'add';
  /** Tokens after `nft <verb> rule ip kici forward`. */
  tokens: string[];
}

/**
 * Build the per-identifier isolation rule operations.
 *
 * Placement matters because nftables is first-match-wins and the `kici`
 * forward chain is shared: it accumulates rules for every live agent plus
 * any host-level baseline (e.g. wildcard `iifname "kici-*"` RFC1918 drops
 * installed at host bootstrap). Accepts therefore go in via `insert`
 * (chain head) so they beat any pre-existing drop that also matches the
 * traffic; an appended accept after a wildcard drop is dead code. Drops go
 * in via `add` (tail) — they only need to beat the chain's accept policy.
 *
 * Effective per-identifier order: gateway + allowlist accepts (head),
 * RFC1918 / metadata / denyAll drops (tail).
 */
export function buildIsolationRuleOps(
  matchClause: string[],
  gatewayIp: string,
  networkPolicy?: NetworkPolicy,
): NftRuleOp[] {
  const ops: NftRuleOp[] = [];

  // 1. Gateway exception — chain head.
  ops.push({ verb: 'insert', tokens: [...matchClause, 'ip', 'daddr', gatewayIp, 'accept'] });

  // 2. Allowlisted CIDRs — chain head, for the same reason as the gateway
  //    rule: an allowlisted destination inside a dropped range (e.g. a
  //    10.x registry endpoint behind a wildcard 10.0.0.0/8 drop) must be
  //    accepted before the drop is evaluated.
  if (networkPolicy?.allowlist) {
    for (const cidr of networkPolicy.allowlist) {
      ops.push({ verb: 'insert', tokens: [...matchClause, 'ip', 'daddr', cidr, 'accept'] });
    }
  }

  // 3. Block RFC1918 ranges.
  for (const range of RFC1918_RANGES) {
    ops.push({ verb: 'add', tokens: [...matchClause, 'ip', 'daddr', range, 'drop'] });
  }

  // 4. Block cloud metadata.
  ops.push({ verb: 'add', tokens: [...matchClause, 'ip', 'daddr', METADATA_RANGE, 'drop'] });

  // 5. Deny all remaining traffic if requested.
  if (networkPolicy?.denyAll) {
    ops.push({ verb: 'add', tokens: [...matchClause, 'drop'] });
  }

  return ops;
}

/**
 * Add network isolation rules for a specific network interface.
 * Used by Firecracker and container backends.
 *
 * Rule placement (see buildIsolationRuleOps):
 * 1. Accept gateway traffic (inserted at chain head)
 * 2. Accept allowlisted CIDRs (inserted at chain head)
 * 3. Drop RFC1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * 4. Drop cloud metadata (169.254.0.0/16)
 * 5. Drop all remaining traffic (only if denyAll is true)
 *
 * @param identifier - Network interface name or source IP to match (e.g., "veth-abc123" or "172.30.0.5")
 * @param gatewayIp - Gateway IP that must remain accessible (e.g., "10.0.0.1")
 * @param networkPolicy - Optional policy with allowlist and denyAll settings
 * @param matchMode - How to match traffic: 'iifname' for interface name (default), 'saddr' for source IP
 */
export async function addIsolationRules(
  identifier: string,
  gatewayIp: string,
  networkPolicy?: NetworkPolicy,
  matchMode: NftMatchMode = 'iifname',
  opts: NftOptions = {},
): Promise<void> {
  const matchLabel =
    matchMode === 'iifname' ? `interface ${identifier}` : `source IP ${identifier}`;
  logger.info(`Adding isolation rules for ${matchLabel} (gateway: ${gatewayIp})`);

  // Build match clause tokens based on mode
  const matchClause: string[] =
    matchMode === 'iifname' ? ['iifname', identifier] : ['ip', 'saddr', identifier];

  if (networkPolicy?.allowlist) {
    for (const cidr of networkPolicy.allowlist) {
      logger.debug(`Allowlisting ${cidr} for ${matchLabel}`);
    }
  }
  if (networkPolicy?.denyAll) {
    logger.info(`Blocking all outbound traffic for ${matchLabel} (denyAll)`);
  }

  for (const op of buildIsolationRuleOps(matchClause, gatewayIp, networkPolicy)) {
    await nft(opts, op.verb, 'rule', 'ip', 'kici', 'forward', ...op.tokens);
  }

  logger.info(`Isolation rules applied for ${matchLabel}`);
}

/**
 * Remove all isolation rules matching a specific interface from the kici forward chain.
 * Called during agent cleanup/destruction.
 *
 * Lists all rules with handles, finds those matching the interface name, and deletes them.
 * Best-effort: logs errors but does not throw (cleanup should not block destruction).
 *
 * @param interfaceName - Network interface whose rules should be removed
 */
export async function removeIsolationRules(
  interfaceName: string,
  opts: NftOptions = {},
): Promise<void> {
  logger.info(`Removing isolation rules for interface ${interfaceName}`);

  try {
    const output = await nft(opts, '-a', 'list', 'chain', 'ip', 'kici', 'forward');
    const handles = parseRuleHandles(output, interfaceName);

    if (handles.length === 0) {
      logger.debug(`No rules found for interface ${interfaceName}`);
      return;
    }

    // Delete in reverse order (highest handle first) to avoid handle shifts
    for (const handle of handles.sort((a, b) => b - a)) {
      try {
        await nft(opts, 'delete', 'rule', 'ip', 'kici', 'forward', 'handle', String(handle));
      } catch (err) {
        logger.warn(`Failed to delete rule handle ${handle}: ${err}`);
      }
    }

    logger.info(`Removed ${handles.length} rules for interface ${interfaceName}`);
  } catch (err) {
    logger.warn(`Failed to list/remove rules for ${interfaceName}: ${err}`);
  }
}

/**
 * Re-export NftOptions type for use by callers (Firecracker / container backends)
 * that need to pass the requireSudo flag through to these functions.
 */
export type { NftOptions };

/**
 * Parse nft rule listing output and extract handles for rules matching a given identifier.
 * Handles lines like: `  iifname "veth-abc" ip daddr 10.0.0.0/8 drop # handle 42`
 *
 * @param nftOutput - Raw output from `nft -a list chain ip kici <chain>`
 * @param identifier - String to search for in each rule line (interface name or UID)
 * @returns Array of numeric rule handles
 */
export function parseRuleHandles(nftOutput: string, identifier: string): number[] {
  const handles: number[] = [];
  const lines = nftOutput.split('\n');

  // Boundary-aware match: a bare substring test would make IP identifier
  // "10.0.0.2" also claim rules for "10.0.0.20" (and likewise for interface
  // name prefixes), so the identifier must be delimited by whitespace or
  // quotes on both sides.
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryRe = new RegExp(`(^|[\\s"])${escaped}([\\s"]|$)`);

  for (const line of lines) {
    // Skip non-rule lines (chain header, closing brace, etc.)
    if (!line.includes('# handle')) continue;

    // Check if this rule references our identifier
    if (!boundaryRe.test(line)) continue;

    // Extract handle number from `# handle N`
    const match = line.match(/# handle (\d+)/);
    if (match) {
      handles.push(parseInt(match[1], 10));
    }
  }

  return handles;
}
