/**
 * Programmatic nftables rule management for agent network isolation.
 *
 * Manages RFC1918 + cloud metadata blocking rules per-interface (Firecracker/container)
 * or per-UID (bare-metal). All operations use `nft` CLI via child_process.execFile.
 *
 * Table layout:
 *   table ip kici {
 *     chain forward { type filter hook forward priority 0; policy accept; }
 *     chain input   { type filter hook input priority 0; policy accept; }
 *     chain output  { type filter hook output priority 0; policy accept; }
 *   }
 *
 * `forward` and `input` answer different questions and both are needed. A
 * packet a sandbox sends to one of the host's OWN addresses — a bridge gateway,
 * the host's LAN address — is delivered on the input hook and never traverses
 * forward, so a forward rule cannot see it. `forward` governs what a sandbox
 * reaches THROUGH the host; `input` governs what it reaches ON the host.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, toErrorMessage } from '@kici-dev/core';

/**
 * Network policy controlling RFC1918 and internet access for the agents or job
 * containers in one label set.
 *
 * Lives here rather than beside the scaler's own types because both the
 * orchestrator's scaler (agent containers and Firecracker VMs) and the agent's
 * container backend (nested job containers) build rules from it. The
 * orchestrator re-exports it from `scaler/types.ts` so its call sites are
 * unchanged.
 */
export interface NetworkPolicy {
  /** CIDR ranges allowed as exceptions to the default RFC1918 block */
  allowlist?: string[];
  /** Block all outbound traffic except allowlisted ranges */
  denyAll?: boolean;
  /**
   * What this source class may reach on the HOST itself, in the
   * `<cidr|address|*>[:<port|*>]` vocabulary {@link parseHostAccess} reads.
   * Everything else host-destined is dropped.
   *
   * Distinct from {@link allowlist}, which governs the `forward` hook and so
   * answers what a sandbox reaches *through* the host. Leaving this undefined
   * means the caller supplies its own class default; an empty array means
   * "reach nothing on the host".
   */
  hostAccess?: string[];
}

/**
 * One parsed {@link NetworkPolicy.hostAccess} entry.
 *
 * `null` means "unconstrained" on both fields: a `daddr` of `null` matches
 * every host address (nft omits the `ip daddr` clause), and a `port` of
 * `null` matches every port.
 */
export interface HostAccessRule {
  daddr: string | null;
  port: number | null;
}

/** Transport protocols a port-scoped host-access accept is emitted for. */
const HOST_ACCESS_PROTOCOLS = ['tcp', 'udp'] as const;

/** An IPv4 dotted quad, optionally with a CIDR prefix length. */
const IPV4_OR_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

/** True when every octet is in range and the prefix length, if any, is 0-32. */
function isIpv4OrCidr(value: string): boolean {
  const match = IPV4_OR_CIDR_RE.exec(value);
  if (!match) return false;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    if (!Number.isInteger(octet) || octet > 255) return false;
  }
  if (match[5] !== undefined) {
    const prefix = Number(match[5]);
    if (!Number.isInteger(prefix) || prefix > 32) return false;
  }
  return true;
}

/**
 * Parse one host-access entry.
 *
 * Grammar: `<cidr|address|*>` optionally followed by `:<port|*>`. A bare number
 * is a port on any host address, which is the common case — an operator naming
 * a host-local registry mirror knows its port, not the host's dynamic
 * addresses.
 *
 * Hostnames are rejected on purpose: nftables matches addresses, so resolving a
 * name at rule-build time produces a rule that goes stale silently the next
 * time the name moves.
 *
 * @throws Error naming the entry and what is wrong with it
 */
export function parseHostAccess(entry: string): HostAccessRule {
  const trimmed = entry.trim();
  if (trimmed.length === 0) throw new Error('hostAccess entry is empty');

  // A bare number is a port, not an address.
  if (/^\d+$/.test(trimmed)) {
    return { daddr: null, port: parseHostAccessPort(trimmed, entry) };
  }

  const colon = trimmed.lastIndexOf(':');
  const addressPart = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const portPart = colon === -1 ? null : trimmed.slice(colon + 1);

  if (addressPart !== '*' && !isIpv4OrCidr(addressPart)) {
    throw new Error(
      `hostAccess entry "${entry}" names "${addressPart}", which is not an IPv4 address, ` +
        `an IPv4 CIDR, or "*". Hostnames are not accepted — nftables matches addresses, and a ` +
        `name resolved at rule-build time goes stale without warning.`,
    );
  }

  const port = portPart === null || portPart === '*' ? null : parseHostAccessPort(portPart, entry);
  return { daddr: addressPart === '*' ? null : addressPart, port };
}

/** Parse and range-check the port half of a host-access entry. */
function parseHostAccessPort(value: string, entry: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`hostAccess entry "${entry}" has a non-numeric port "${value}"`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`hostAccess entry "${entry}" has port ${value}, outside 1-65535`);
  }
  return port;
}

/**
 * Build the host-access rules for one identifier, in final head-to-tail order:
 * the conntrack exception, every accept, then one terminal drop.
 *
 * The conntrack rule leads because the chain is keyed on the sandbox as the
 * SOURCE, so it also sees the reply leg of a connection the HOST opened toward
 * the sandbox — a readiness probe, a metrics scrape. Without the exception
 * those replies fall through to the terminal drop and the host's own connection
 * dies as an opaque timeout. It widens nothing a sandbox can initiate:
 * `established` is reached only by a flow whose first packet was already
 * accepted, so a sandbox connecting to a port with no accept still has its SYN
 * dropped and never reaches that state.
 *
 * A port-scoped entry emits an accept per protocol in
 * {@link HOST_ACCESS_PROTOCOLS}. UDP is not optional: a container whose
 * resolver is the bridge gateway — which is what rootful podman with
 * aardvark-dns gives it — resolves over UDP, so a tcp-only accept on port 53
 * leaves it unable to resolve any name.
 *
 * @returns one token list per rule, in final head-to-tail order
 */
export function buildHostAccessRuleOps(matchClause: string[], hostAccess: string[]): string[][] {
  const rules: string[][] = [[...matchClause, 'ct', 'state', 'established,related', 'accept']];

  for (const entry of hostAccess) {
    const { daddr, port } = parseHostAccess(entry);
    const scoped = daddr === null ? matchClause : [...matchClause, 'ip', 'daddr', daddr];
    if (port === null) {
      rules.push([...scoped, 'accept']);
      continue;
    }
    for (const protocol of HOST_ACCESS_PROTOCOLS) {
      rules.push([...scoped, protocol, 'dport', String(port), 'accept']);
    }
  }

  rules.push([...matchClause, 'drop']);
  return rules;
}

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
 * Subnet of the agent's `kici-jobs` bridge, on which the agent keys ONE drop set
 * covering every nested job container — including one that does not exist yet.
 *
 * It lives here rather than beside the agent's own network constants because
 * the Firecracker host provisioner has to recognise those rules to leave them
 * alone, and the orchestrator carries `@kici-dev/agent` only as a devDependency.
 * The agent module re-exports it, so its own call sites are unchanged.
 */
export const JOB_NETWORK_SUBNET = '172.31.0.0/16';

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

  /**
   * nftables table these rules live in. Defaults to {@link DEFAULT_NFT_TABLE}.
   *
   * The Firecracker backend exposes this as an operator knob so two
   * coordinators on one host get disjoint tables; the per-VM rules must follow
   * the same knob as the bridge baseline, or coordinator B's rules land in
   * coordinator A's table and A's next provision wipes them.
   */
  table?: string;
}

/** Table used when {@link NftOptions.table} is not set. */
export const DEFAULT_NFT_TABLE = 'kici';

/** The configured table, or the default. */
function tableOf(opts: NftOptions): string {
  return opts.table ?? DEFAULT_NFT_TABLE;
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
 * Ensure the nftables table and the chains this module writes to exist.
 * Idempotent -- safe to call multiple times.
 *
 * Every chain is verified individually. A bare "does the table exist?" check is
 * not enough: the Firecracker host provisioner creates the table before this
 * module ever runs, so a table with no `forward` chain satisfied the old early
 * return — and then every `addIsolationRules` failed with nft's "No such file
 * or directory", leaving every VM on that host with no isolation rules at all.
 *
 * @param opts - `table` selects the table; `requireBaselineChain` additionally
 * ensures the regular {@link BASELINE_CHAIN} exists (Firecracker hosts, whose
 * `forward` chain ends in a jump to it).
 */
export async function ensureKiciTable(
  opts: NftOptions & { requireBaselineChain?: boolean } = {},
): Promise<void> {
  const table = tableOf(opts);

  // `nft add` is idempotent for tables and chains, so this is a create-or-noop
  // rather than a check-then-create — there is no window between the two.
  await nft(opts, 'add', 'table', 'ip', table);

  // Forward chain (interface- and source-IP filtering: Firecracker, containers).
  await nft(
    opts,
    'add',
    'chain',
    'ip',
    table,
    'forward',
    '{ type filter hook forward priority 0; policy accept; }',
  );

  // Input chain (what a sandbox may reach ON the host, rather than through it).
  await ensureKiciInputChain(opts);

  // Output chain (UID-based filtering: bare-metal).
  await nft(
    opts,
    'add',
    'chain',
    'ip',
    table,
    'output',
    '{ type filter hook output priority 0; policy accept; }',
  );

  if (opts.requireBaselineChain === true) {
    await nft(opts, 'add', 'chain', 'ip', table, BASELINE_CHAIN);
  }

  logger.debug(`nftables table ip ${table} and chains ready`);
}

/** Chain in the kici table that filters host-destined sandbox traffic. */
export const INPUT_CHAIN = 'input';

/**
 * Ensure the kici table and its `input` chain exist. Idempotent — `nft add` is
 * a create-or-noop for both, so there is no check-then-create window.
 *
 * The chain's policy is `accept` because it is a base chain on the host's own
 * input hook: everything the host itself receives passes through it, and a
 * default-deny there would take the machine off the network. The deny lives in
 * the per-identifier terminal drop {@link buildHostAccessRuleOps} emits.
 */
export async function ensureKiciInputChain(opts: NftOptions = {}): Promise<void> {
  const table = tableOf(opts);
  await nft(opts, 'add', 'table', 'ip', table);
  await nft(
    opts,
    'add',
    'chain',
    'ip',
    table,
    INPUT_CHAIN,
    '{ type filter hook input priority 0; policy accept; }',
  );
}

/**
 * Apply one identifier's host-access rules to the `input` chain, replacing
 * whatever it had.
 *
 * The pre-clean is not an optimisation. Bridge networks recycle addresses, so a
 * crash or a `kill -9` leaves the previous holder's accepts behind for the next
 * container on that IP to inherit — which is the boundary this chain exists to
 * hold. Applying without removing first would also stack a second terminal drop
 * above the first run's accepts, shadowing every one of them.
 *
 * Rules are `insert`ed in reverse so the block lands at the chain head in the
 * order {@link buildHostAccessRuleOps} returns: accepts first, terminal drop
 * last. Inserting forwards would put the drop above the accepts and deny
 * everything.
 */
export async function addHostIsolationRules(
  identifier: string,
  hostAccess: string[],
  matchMode: NftMatchMode = 'saddr',
  opts: NftOptions = {},
): Promise<void> {
  await ensureKiciInputChain(opts);
  await removeHostIsolationRules(identifier, opts);

  const matchClause: string[] =
    matchMode === 'iifname' ? ['iifname', identifier] : ['ip', 'saddr', identifier];
  const rules = buildHostAccessRuleOps(matchClause, hostAccess);

  for (const tokens of [...rules].reverse()) {
    await nft(opts, 'insert', 'rule', 'ip', tableOf(opts), INPUT_CHAIN, ...tokens);
  }

  logger.info(
    `Host-access rules applied for ${identifier}: ${hostAccess.length > 0 ? hostAccess.join(', ') : 'nothing (host fully denied)'}`,
  );
}

/**
 * A table's `input` chain, as `nft -a list chain` prints it, or `null` when the
 * table or the chain does not exist yet.
 *
 * Returning `null` rather than throwing keeps "the chain is not there" distinct
 * from "the chain is there and holds nothing", which a caller deciding whether
 * a rule set is already installed has to be able to tell apart.
 */
export async function readInputChain(opts: NftOptions = {}): Promise<string | null> {
  try {
    return await nft(opts, '-a', 'list', 'chain', 'ip', tableOf(opts), INPUT_CHAIN);
  } catch {
    return null;
  }
}

/**
 * Remove one identifier's rules from the `input` chain.
 *
 * Best-effort: a missing chain, or a rule another path already deleted, must
 * not abort a teardown.
 */
export async function removeHostIsolationRules(
  identifier: string,
  opts: NftOptions = {},
): Promise<void> {
  const table = tableOf(opts);
  const output = await readInputChain(opts);
  // No table or no chain yet — nothing this identifier could own.
  if (output === null) return;

  const handles = parseRuleHandles(output, identifier);
  if (handles.length === 0) return;

  for (const handle of handles.sort((a, b) => b - a)) {
    try {
      await nft(opts, 'delete', 'rule', 'ip', table, INPUT_CHAIN, 'handle', String(handle));
    } catch (err) {
      logger.warn(`Failed to delete input rule handle ${handle}: ${toErrorMessage(err)}`);
    }
  }
  logger.info(`Removed ${handles.length} host-access rules for ${identifier}`);
}

/**
 * Name of the regular (non-hooked) chain holding the host baseline rules.
 *
 * The Firecracker host provisioner puts its six source-scoped baseline rules
 * here and reaches them with a `jump` appended as the `forward` chain's LAST
 * rule. Two properties follow, and both are load-bearing:
 *
 *  - **Per-VM rules always win.** They are inserted at the `forward` head, so
 *    every one of them is evaluated before the jump. A per-VM `accept`
 *    terminates the hook before the baseline can re-drop an allowlisted
 *    destination, and a per-VM `denyAll` drop is terminal before the
 *    baseline's blanket internet `accept` can let the packet out.
 *  - **A self-heal can rebuild the baseline without touching live VMs.** The
 *    provisioner flushes and refills only this chain, so it never has to
 *    `delete table` — which used to drop every running VM's isolation rules
 *    fail-open.
 *
 * A regular chain reached by `jump` rather than a second base chain at a lower
 * priority: in netfilter an `accept` ends only the current base chain, so an
 * allowlist accept in an earlier base chain would still be re-evaluated — and
 * dropped — by the baseline's 10.0.0.0/8 rule in the later one.
 */
export const BASELINE_CHAIN = 'baseline';

/**
 * Build the per-identifier isolation rules in their final head-to-tail order.
 *
 * nftables is first-match-wins within a chain and `accept` is terminal, so the
 * order below is the whole security property:
 *
 *  1. gateway accept
 *  2. allowlisted CIDR accepts — ahead of the drops, so an allowlisted
 *     destination inside a dropped range (a 10.x registry endpoint behind the
 *     10.0.0.0/8 drop) is accepted before the drop is evaluated
 *  3. RFC1918 drops
 *  4. cloud-metadata drop
 *  5. `denyAll` drop
 *
 * {@link addIsolationRules} lands them in exactly this order by applying the
 * list in REVERSE with `insert`, which puts the whole block at the chain head —
 * ahead of the tail `jump` to {@link BASELINE_CHAIN}.
 *
 * @returns one token list per rule, in final head-to-tail order
 */
export function buildIsolationRuleOps(
  matchClause: string[],
  gatewayIp: string,
  networkPolicy?: NetworkPolicy,
): string[][] {
  const rules: string[][] = [];

  // 1. Gateway exception.
  rules.push([...matchClause, 'ip', 'daddr', gatewayIp, 'accept']);

  // 2. Allowlisted CIDRs.
  for (const cidr of networkPolicy?.allowlist ?? []) {
    rules.push([...matchClause, 'ip', 'daddr', cidr, 'accept']);
  }

  // 3. Block RFC1918 ranges.
  for (const range of RFC1918_RANGES) {
    rules.push([...matchClause, 'ip', 'daddr', range, 'drop']);
  }

  // 4. Block cloud metadata.
  rules.push([...matchClause, 'ip', 'daddr', METADATA_RANGE, 'drop']);

  // 5. Deny all remaining traffic if requested.
  if (networkPolicy?.denyAll) {
    rules.push([...matchClause, 'drop']);
  }

  return rules;
}

/**
 * Add network isolation rules for one identifier (a TAP interface name, or a
 * container's source IP).
 *
 * Every rule is `insert`ed, applying {@link buildIsolationRuleOps} in reverse,
 * so the block lands at the chain head in its documented order — ahead of any
 * host baseline reached by a tail `jump`.
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

  const rules = buildIsolationRuleOps(matchClause, gatewayIp, networkPolicy);
  for (const tokens of [...rules].reverse()) {
    await nft(opts, 'insert', 'rule', 'ip', tableOf(opts), 'forward', ...tokens);
  }

  logger.info(`Isolation rules applied for ${matchLabel}`);
}

/**
 * A table's `forward` chain, as `nft -a list chain` prints it, or `null` when
 * the table or the chain does not exist yet.
 *
 * The text form is what {@link parseRuleHandles} reads, and it is also what a
 * caller asking whether a rule set is ALREADY installed — rather than deleting
 * it — compares against the rule text {@link buildIsolationRuleOps} emits.
 * {@link listForwardRules} cannot answer for a subnet identifier: nft reports a
 * subnet source as a prefix object, which its classifier treats as "not a
 * per-agent rule" on purpose.
 *
 * Returning `null` rather than throwing keeps "the chain is not there" distinct
 * from "the chain is there and holds nothing", exactly as {@link readInputChain}
 * does for the sibling chain. The distinction is load-bearing in the install
 * direction: a caller checking whether a rule set is present must read a missing
 * chain as NOT installed and go install it, and a throw instead aborts the whole
 * ensure path — which for the agent's job network degrades to a container on an
 * unfiltered bridge.
 */
export async function readForwardChain(opts: NftOptions = {}): Promise<string | null> {
  try {
    return await nft(opts, '-a', 'list', 'chain', 'ip', tableOf(opts), 'forward');
  } catch {
    return null;
  }
}

/**
 * Remove every isolation rule this identifier owns, in both the `forward` and
 * the `input` chain. Called during agent cleanup, and as the pre-clean before a
 * re-add.
 *
 * Both chains are swept because they are one boundary: an identifier is a
 * container IP or a TAP name, addresses are recycled, and leaving the input
 * chain's accepts behind hands the next tenant on that address the previous
 * one's host reachability.
 *
 * Best-effort: logs errors but does not throw (cleanup must not block
 * destruction).
 *
 * @param interfaceName - Network interface name or source IP whose rules should be removed
 */
export async function removeIsolationRules(
  interfaceName: string,
  opts: NftOptions = {},
): Promise<void> {
  logger.info(`Removing isolation rules for interface ${interfaceName}`);
  await removeHostIsolationRules(interfaceName, opts);

  try {
    const table = tableOf(opts);
    const output = await readForwardChain(opts);
    // No table or no chain yet — nothing this identifier could own.
    if (output === null) return;
    const handles = parseRuleHandles(output, interfaceName);

    if (handles.length === 0) {
      logger.debug(`No rules found for interface ${interfaceName}`);
      return;
    }

    // Delete in reverse order (highest handle first) to avoid handle shifts
    for (const handle of handles.sort((a, b) => b - a)) {
      try {
        await nft(opts, 'delete', 'rule', 'ip', table, 'forward', 'handle', String(handle));
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

/** One rule in the forward chain, as reported by `nft -j -a list chain`. */
export interface NftForwardRule {
  /** nft rule handle, for `nft delete rule … handle N`. */
  handle: number;
  /**
   * The per-identifier value this rule matches on — a concrete source IP or a
   * concrete interface name — or `null` for a rule that is not per-identifier
   * (a host baseline rule matching a whole subnet or a `kici-*` wildcard, or a
   * `jump`).
   */
  identifier: string | null;
}

/**
 * Read every rule in a table's forward chain, with its handle and the per-agent
 * identifier it matches on.
 *
 * This is the enumerate-what-is-there half of rule management; the
 * identifier-known delete path is {@link parseRuleHandles}. Reconciliation
 * needs this one: rules are removed only on the synchronous teardown paths this
 * process drives, so an orchestrator crash, a `kill -9`, or a VM that dies
 * while the orchestrator is down strands `ip saddr <ip> …` rules in the shared
 * chain forever. The allocator then hands that IP to another tenant, who
 * inherits the dead job's allowlist.
 *
 * Returns an empty list rather than throwing when the chain cannot be read —
 * the caller is a best-effort sweep, and a failed read must not be mistaken
 * for "nothing is there".
 */
export async function listForwardRules(opts: NftOptions = {}): Promise<NftForwardRule[]> {
  const table = tableOf(opts);
  let parsed: unknown;
  try {
    const output = await nft(opts, '-j', '-a', 'list', 'chain', 'ip', table, 'forward');
    parsed = JSON.parse(output);
  } catch (err) {
    logger.warn(`Failed to list forward rules in ip ${table}: ${toErrorMessage(err)}`);
    return [];
  }
  const entries = (parsed as { nftables?: unknown[] })?.nftables;
  if (!Array.isArray(entries)) return [];

  const rules: NftForwardRule[] = [];
  for (const entry of entries) {
    const rule = (entry as { rule?: { handle?: unknown; expr?: unknown[] } }).rule;
    if (!rule || typeof rule.handle !== 'number') continue;
    rules.push({ handle: rule.handle, identifier: identifierOf(rule.expr) });
  }
  return rules;
}

/**
 * The concrete per-agent identifier a rule's expression list matches on.
 *
 * A per-agent rule matches a single host — `ip saddr 10.0.0.5` — or one exact
 * interface — `iifname "kici-a1b2c3d4"`. A host baseline rule matches a whole
 * subnet, which nft reports as a `{ prefix: … }` object, and every one of them
 * also names the `kici-*` interface wildcard. That difference is the only thing
 * separating "a live agent owns this" from "the host installed this".
 *
 * The whole rule is scanned before answering, and a wildcard anywhere in it
 * settles the question. Position is why: the host's inbound established/related
 * rule LEADS with `iifname "<egress iface>"` — a concrete name carrying no `*`
 * — and names the wildcard only later, in `oifname`. Returning on the first
 * concrete interface therefore claimed that rule for a nonexistent agent named
 * after the host NIC, so the provisioning sweep spared it and every re-provision
 * left another stale copy behind.
 */
function identifierOf(expr: unknown): string | null {
  if (!Array.isArray(expr)) return null;
  let candidate: string | null = null;
  for (const node of expr) {
    const match = (node as { match?: { left?: unknown; right?: unknown } }).match;
    if (!match) continue;
    const left = match.left as
      { payload?: { field?: string }; meta?: { key?: string } } | undefined;
    const right = match.right;
    if (typeof right !== 'string') {
      // A prefix object is a subnet, and only the host writes a subnet match.
      if (left?.payload?.field === 'saddr') return null;
      continue;
    }
    if (right.includes('*')) return null;
    if (candidate !== null) continue;
    if (left?.payload?.field === 'saddr') candidate = right;
    else if (left?.meta?.key === 'iifname') candidate = right;
  }
  return candidate;
}

/**
 * Every per-agent identifier currently present in the forward chain, mapped to
 * the handles of the rules that carry it.
 */
export async function listIsolationRules(opts: NftOptions = {}): Promise<Map<string, number[]>> {
  const byIdentifier = new Map<string, number[]>();
  for (const rule of await listForwardRules(opts)) {
    if (rule.identifier === null) continue;
    const handles = byIdentifier.get(rule.identifier);
    if (handles) handles.push(rule.handle);
    else byIdentifier.set(rule.identifier, [rule.handle]);
  }
  return byIdentifier;
}

/**
 * Delete rules from a table's forward chain by handle, highest first so earlier
 * deletions cannot shift the handles still to come.
 *
 * Best-effort per handle: a rule another path already removed must not abort
 * the rest of the sweep.
 */
export async function deleteForwardRules(
  handles: number[],
  opts: NftOptions = {},
): Promise<number> {
  const table = tableOf(opts);
  let deleted = 0;
  for (const handle of [...handles].sort((a, b) => b - a)) {
    try {
      await nft(opts, 'delete', 'rule', 'ip', table, 'forward', 'handle', String(handle));
      deleted++;
    } catch (err) {
      logger.warn(`Failed to delete rule handle ${handle} in ip ${table}: ${toErrorMessage(err)}`);
    }
  }
  return deleted;
}

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
