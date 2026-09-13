/**
 * Firecracker host-network provisioning.
 *
 * Creates the per-coordinator bridge (kici-brN), assigns its gateway IP,
 * marks kici-* interfaces unmanaged by NetworkManager, enables IP forwarding,
 * and builds a disjoint, source-scoped nftables table for NAT + egress
 * isolation. One pure command-builder drives live provisioning, the rendered
 * boot script, and (read-only) verification.
 *
 * This is HOST setup, distinct from the runtime per-VM isolation the rule
 * builder in `@kici-dev/shared/net` performs (added at spawn / removed at
 * destroy). The two share the nft table name but have separate lifecycles;
 * this module never touches the per-VM rules.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  RFC1918_RANGES,
  METADATA_RANGE,
  BASELINE_CHAIN,
  JOB_NETWORK_SUBNET,
  listForwardRules,
  deleteForwardRules,
  parseRuleHandles,
  readForwardChain,
} from '@kici-dev/shared/net';
import { FIRECRACKER_NET_INTERFACES } from './net-interfaces.js';

// Re-exported so the orchestrator's own consumers keep importing it from the
// module that renders the drop-in; it lives in a leaf module so out-of-package
// readers (the NM drift watchdog) do not pull this module's runtime graph.
export { FIRECRACKER_NET_INTERFACES };

const execFileP = promisify(execFileCb);
const logger = createLogger({ prefix: 'fc-host-network' });

/** Privileged binaries that need `sudo -n` on a non-root orchestrator host. */
const PRIVILEGED_BINS = new Set(['ip', 'nft', 'sysctl', 'iptables']);

/** Timeout for a single host-network provisioning command. */
const COMMAND_TIMEOUT_MS = 30_000;

/** A single subprocess invocation (no shell). */
export interface CommandSpec {
  bin: string;
  args: string[];
  /** Optional stdin payload (used for `nft -f -`). */
  stdin?: string;
}

/** Host-bridge configuration for one Firecracker coordinator. */
export interface FirecrackerBridgeConfig {
  /** Bridge interface name, e.g. 'kici-br0'. */
  bridgeName: string;
  /** Gateway IP + prefix, e.g. '10.0.0.1/24'. */
  bridgeCidr: string;
  /** nft table name, e.g. 'kici' or 'kici_b'. */
  table: string;
  /** NAT egress interface; auto-detected from the default route when omitted. */
  hostIface?: string;
}

/**
 * Derive the network address (CIDR) from a gateway CIDR by masking host bits.
 * '10.0.0.1/24' -> '10.0.0.0/24'.
 */
export function cidrToNetwork(cidr: string): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) throw new Error(`Invalid CIDR "${cidr}" (expected a.b.c.d/prefix)`);
  const octets = [m[1], m[2], m[3], m[4]].map((o) => Number(o));
  for (const o of octets) {
    if (o > 255) throw new Error(`Invalid octet in CIDR "${cidr}" (each octet must be 0-255)`);
  }
  const prefix = Number(m[5]);
  if (prefix > 32) throw new Error(`Invalid prefix /${prefix} in CIDR "${cidr}" (max /32)`);
  // Build the 32-bit address, apply the prefix mask.
  const addr = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (addr & mask) >>> 0;
  const netOctets = [(net >>> 24) & 0xff, (net >>> 16) & 0xff, (net >>> 8) & 0xff, net & 0xff];
  return `${netOctets.join('.')}/${prefix}`;
}

/** Bridge-name prefix used as the iifname match (matches the bridge + its TAP members). */
function bridgePrefix(bridgeName: string): string {
  // 'kici-br0' -> 'kici-*' (TAP devices forward with the TAP iifname, all kici-*).
  return `${bridgeName.split('-')[0]}-*`;
}

/**
 * Build the ordered command list that provisions one Firecracker host bridge.
 * Pure — performs no I/O. `provisionBridge` executes these; `renderBootScript`
 * serializes them.
 *
 * The command list NEVER deletes the table. It is a self-heal — `ensureHostReady`
 * runs it whenever `verifyBridge` reports unhealthy, which happens on any of
 * four conditions none of which knows how many VMs are live — so dropping the
 * table would leave every running VM fail-open, with full RFC1918 and
 * cloud-metadata reach, until it was destroyed. Instead the baseline lives in
 * its own regular chain (`baseline`, see {@link BASELINE_CHAIN}) that is flushed
 * and refilled, and the hooked `forward` chain keeps its per-VM rules
 * untouched, reaching the baseline through a `jump` appended as its last rule.
 *
 * Every forward/postrouting/MSS rule is source-scoped to the bridge subnet so
 * two tables on the shared hooks do not cross-drop each other's traffic.
 */
export function buildBridgeCommands(cfg: FirecrackerBridgeConfig): CommandSpec[] {
  const iface = cfg.hostIface;
  if (!iface) {
    throw new Error(
      'buildBridgeCommands requires a resolved hostIface (call resolveHostIface first)',
    );
  }
  const subnet = cidrToNetwork(cfg.bridgeCidr);
  const gatewayIp = cfg.bridgeCidr.split('/')[0];
  const prefix = bridgePrefix(cfg.bridgeName);
  const t = cfg.table;
  const nft = (...args: string[]): CommandSpec => ({ bin: 'nft', args });
  const saddr = ['ip', 'saddr', subnet];

  return [
    // 1. Bridge.
    { bin: 'ip', args: ['link', 'add', 'name', cfg.bridgeName, 'type', 'bridge'] },
    { bin: 'ip', args: ['addr', 'add', cfg.bridgeCidr, 'dev', cfg.bridgeName] },
    { bin: 'ip', args: ['link', 'set', cfg.bridgeName, 'up'] },
    // 2. Forwarding.
    { bin: 'sysctl', args: ['-w', 'net.ipv4.ip_forward=1'] },
    // 3. Table + chains. `add` is idempotent for both, and the table is never
    //    deleted — see the note above.
    nft('add', 'table', 'ip', t),
    // 4. Postrouting masquerade, source-scoped. The chain holds nothing but
    //    this rule, so flushing it is safe and makes the re-add idempotent.
    nft(
      'add',
      'chain',
      t,
      'postrouting',
      '{ type nat hook postrouting priority srcnat; policy accept; }',
    ),
    nft('flush', 'chain', t, 'postrouting'),
    nft('add', 'rule', t, 'postrouting', ...saddr, 'oifname', iface, 'masquerade'),
    // 5. The hooked forward chain (per-VM rules live here — never flushed) and
    //    the regular baseline chain it jumps to (owned entirely by this
    //    provisioner, so it IS flushed and refilled on every run).
    nft(
      'add',
      'chain',
      t,
      'forward',
      '{ type filter hook forward priority filter; policy accept; }',
    ),
    nft('add', 'chain', t, BASELINE_CHAIN),
    nft('flush', 'chain', t, BASELINE_CHAIN),
    // 6. Baseline rules, source-scoped (order matters: gateway accept, RFC1918
    //    drops, metadata drop, internet accept, established, MSS).
    nft(
      'add',
      'rule',
      t,
      BASELINE_CHAIN,
      ...saddr,
      'iifname',
      prefix,
      'ip',
      'daddr',
      gatewayIp,
      'accept',
    ),
    ...RFC1918_RANGES.map((r) =>
      nft('add', 'rule', t, BASELINE_CHAIN, ...saddr, 'iifname', prefix, 'ip', 'daddr', r, 'drop'),
    ),
    nft(
      'add',
      'rule',
      t,
      BASELINE_CHAIN,
      ...saddr,
      'iifname',
      prefix,
      'ip',
      'daddr',
      METADATA_RANGE,
      'drop',
    ),
    nft('add', 'rule', t, BASELINE_CHAIN, ...saddr, 'iifname', prefix, 'oifname', iface, 'accept'),
    nft(
      'add',
      'rule',
      t,
      BASELINE_CHAIN,
      'iifname',
      iface,
      'ip',
      'daddr',
      subnet,
      'oifname',
      prefix,
      'ct',
      'state',
      'related,established',
      'accept',
    ),
    nft(
      'add',
      'rule',
      t,
      BASELINE_CHAIN,
      ...saddr,
      'tcp',
      'flags',
      'syn',
      '/',
      'syn,rst',
      'tcp',
      'option',
      'maxseg',
      'size',
      'set',
      '1460',
    ),
    // 7. The tail jump. Every per-VM rule is inserted at the forward chain's
    //    HEAD, so appending the jump last makes the evaluation order
    //    permanently: per-VM accepts and drops, then the host baseline. That
    //    ordering is what makes `networkPolicy.denyAll` deny — before this,
    //    the baseline's unconditional internet accept sat ahead of the per-VM
    //    drop and terminated the chain first, so `denyAll` granted full egress.
    //
    //    `provisionBridge` deletes every non-per-VM rule from `forward` before
    //    running this list, so a prior jump (and an old-shaped host baseline
    //    written directly into `forward`) is gone by the time this lands, and
    //    exactly one jump ends up in the chain.
    nft('add', 'rule', t, 'forward', 'jump', BASELINE_CHAIN),
    // 8. Docker coexistence. When docker is co-installed on the FC host it sets
    //    the netfilter FORWARD policy to DROP and only permits its own bridges,
    //    which silently drops the FC bridge's NAT'd guest traffic (no guest
    //    internet). DOCKER-USER is docker's sanctioned hook, evaluated before
    //    its DROP rules; accept the FC subnet there (both directions). Delete-
    //    then-insert keeps it idempotent. On a host without docker the
    //    DOCKER-USER chain is absent and these iptables calls fail benignly
    //    (swallowed by provisionBridge / `|| true` in the boot script).
    { bin: 'iptables', args: ['-D', 'DOCKER-USER', '-s', subnet, '-j', 'ACCEPT'] },
    { bin: 'iptables', args: ['-I', 'DOCKER-USER', '-s', subnet, '-j', 'ACCEPT'] },
    { bin: 'iptables', args: ['-D', 'DOCKER-USER', '-d', subnet, '-j', 'ACCEPT'] },
    { bin: 'iptables', args: ['-I', 'DOCKER-USER', '-d', subnet, '-j', 'ACCEPT'] },
  ];
}

export const NM_CONF_PATH = '/etc/NetworkManager/conf.d/90-kici-unmanaged.conf';

export const NM_CONF_CONTENT = [
  '# Managed by kici-admin firecracker — do not hand-edit.',
  '#',
  "# KiCI's Firecracker scaler creates and destroys many kici-* interfaces",
  '# (TAP devices + bridges). NetworkManager must not manage them: it auto-adopts',
  '# them and can wedge the NM main thread at 100% CPU under churn.',
  '#',
  '# The `+=` append operator is mandatory: NM merges conf.d drop-ins last-wins',
  '# per key, so a bare `unmanaged-devices=` here would be silently clobbered by',
  "# (or would silently clobber) any other drop-in's unmanaged-devices line — e.g.",
  '# the wifi drop-in from @kici-dev/util-linux-management. `+=` accumulates',
  '# across files so every drop-in survives. See',
  '# .claude/rules/networkmanager-unmanaged.md.',
  '[keyfile]',
  ...FIRECRACKER_NET_INTERFACES.map((p) => `unmanaged-devices+=interface-name:${p}`),
  '',
].join('\n');

export type CommandRunner = (spec: CommandSpec) => Promise<{ stdout: string }>;

/** Writes the host-scoped NetworkManager conf. Injectable for tests. */
export type FileWriter = (path: string, content: string) => Promise<void>;

export interface ExecOptions {
  /** Inject a runner for tests. */
  runner?: CommandRunner;
  /** Inject the NM-conf file writer for tests. */
  writeNmConf?: FileWriter;
  /** Wrap privileged bins with `sudo -n` (non-root orchestrator hosts). */
  requireSudo?: boolean;
}

const defaultFileWriter: FileWriter = (path, content) => writeFile(path, content, 'utf8');

function defaultRunner(requireSudo: boolean): CommandRunner {
  return async ({ bin, args, stdin }) => {
    const useSudo = requireSudo && PRIVILEGED_BINS.has(bin);
    const child = useSudo
      ? execFileP('sudo', ['-n', bin, ...args], { timeout: COMMAND_TIMEOUT_MS })
      : execFileP(bin, args, { timeout: COMMAND_TIMEOUT_MS });
    if (stdin && child.child.stdin) {
      child.child.stdin.end(stdin);
    }
    const { stdout } = await child;
    return { stdout: stdout.toString() };
  };
}

/** Resolve the default-route egress interface. */
export async function resolveHostIface(opts: ExecOptions = {}): Promise<string> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  const { stdout } = await runner({ bin: 'ip', args: ['-j', 'route', 'show', 'default'] });
  const routes = JSON.parse(stdout) as Array<{ dev?: string }>;
  const dev = routes.find((r) => r.dev)?.dev;
  if (!dev) throw new Error('could not detect the default-route interface for NAT egress');
  return dev;
}

export interface BridgeHealth {
  bridgeName: string;
  bridgeExists: boolean;
  bridgeUp: boolean;
  addrPresent: boolean;
  tablePresent: boolean;
  /** The regular baseline chain exists and `forward` ends in a jump to it. */
  baselineChainPresent: boolean;
  /** Every enslaved kici-* TAP carries bridge port isolation. */
  tapIsolationPresent: boolean;
  healthy: boolean;
  detail: string;
}

/**
 * Delete every rule in the table's `forward` chain that no live VM owns.
 *
 * A per-VM rule matches one host address or one exact TAP name; everything else
 * in that chain belongs to this provisioner — the tail `jump baseline`, and on
 * a host provisioned by an older boot script, the six baseline rules that used
 * to sit directly in `forward`. Removing only those makes re-provisioning
 * idempotent and upgrades an old-shaped host in place, without the `delete
 * table` that used to strip every running VM's isolation.
 *
 * One exception, and it is not this provisioner's: on a host that also runs a
 * container-mode agent, the agent installs ONE drop set for its whole
 * {@link JOB_NETWORK_SUBNET} rather than one per job container, so that a
 * customer image's `ENTRYPOINT` cannot run ahead of its own rules. nft reports
 * a subnet source as a prefix object, which is exactly what makes
 * `listForwardRules` report no per-agent identifier — so those rules read as
 * this provisioner's and would be reaped, leaving every job container already
 * running at that moment with no egress filtering until the next job repairs
 * it. They are spared by name.
 *
 * Best-effort: a chain that cannot be read yields no rules, so a fresh host
 * sweeps nothing and provisioning proceeds. A chain whose TEXT cannot be read
 * sweeps nothing either — the spared set is unknown at that point, and deleting
 * an unclassified rule from a chain carrying a security control is the wrong
 * direction to guess in.
 */
export async function sweepUnownedForwardRules(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<number> {
  const nftOpts = { requireSudo: opts.requireSudo ?? false, table: cfg.table };
  const candidates = (await listForwardRules(nftOpts))
    .filter((r) => r.identifier === null)
    .map((r) => r.handle);
  if (candidates.length === 0) return 0;

  // `listForwardRules` just enumerated this chain, so a text read that comes
  // back empty-handed here is anomalous rather than a fresh host.
  const chain = await readForwardChain(nftOpts);
  if (chain === null) {
    logger.warn(
      `could not read ip ${cfg.table} forward as text to identify the agent's ` +
        'job-container rules; sweeping nothing this pass',
    );
    return 0;
  }
  const spared = new Set(parseRuleHandles(chain, `ip saddr ${JOB_NETWORK_SUBNET}`));

  const unowned = candidates.filter((handle) => !spared.has(handle));
  if (unowned.length === 0) return 0;
  const deleted = await deleteForwardRules(unowned, nftOpts);
  logger.info(
    `swept ${deleted} host-owned rule(s) from ip ${cfg.table} forward before re-provisioning`,
  );
  return deleted;
}

/** Provision (or heal) one Firecracker host bridge. Throws on any failure. */
export async function provisionBridge(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<void> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  const iface = cfg.hostIface ?? (await resolveHostIface(opts));
  const resolved = { ...cfg, hostIface: iface };

  // NM unmanaged conf (host-scoped) before any bridge churn.
  const writeNmConf = opts.writeNmConf ?? defaultFileWriter;
  try {
    await writeNmConf(NM_CONF_PATH, NM_CONF_CONTENT);
  } catch (err) {
    // Only swallow ENOENT (no NetworkManager dir on this host); anything else is fatal.
    if (!toErrorMessage(err).includes('ENOENT')) {
      throw new Error(`failed to write ${NM_CONF_PATH}: ${toErrorMessage(err)}`);
    }
  }

  // Clear the chain of everything this provisioner owns — a prior `jump
  // baseline`, and any host baseline written directly into `forward` by an
  // older boot script — while leaving every per-VM rule in place. This is what
  // replaces the old `delete table`, which took the live VMs' isolation with
  // it. It must not be split from the chain-split below: running one without
  // the other leaves either a duplicated jump or two baselines.
  await sweepUnownedForwardRules(resolved, opts);

  for (const spec of buildBridgeCommands(resolved)) {
    const line = [spec.bin, ...spec.args].join(' ');
    try {
      await runner(spec);
    } catch (err) {
      const msg = toErrorMessage(err);
      // Idempotency carve-outs: a missing-table delete and an already-existing
      // bridge/addr are expected on re-runs and are NOT failures.
      const benignDelete =
        (line.startsWith('nft delete table') || line.startsWith('nft flush chain')) &&
        /No such file|does not exist/i.test(msg);
      // `ip link add` on a re-run answers "RTNETLINK answers: File exists";
      // `ip addr add` answers "Error: ipv4: Address already assigned." — both
      // mean the resource is already present and the re-run is a no-op.
      const benignExists =
        /File exists|already a member|already assigned|exists/i.test(msg) &&
        (line.includes('link add') || line.includes('addr add'));
      // Docker-coexistence carve-out: the DOCKER-USER accept rules are
      // best-effort. A `-D` of an absent rule, an absent DOCKER-USER chain (no
      // docker on this host), or a missing iptables binary must not fail
      // provisioning.
      const benignDockerUser =
        line.includes('DOCKER-USER') &&
        /does a matching rule exist|does not exist|No chain|not found|ENOENT|command not found/i.test(
          msg,
        );
      if (benignDelete || benignExists || benignDockerUser) {
        logger.debug(`idempotent skip: ${line} (${msg})`);
        continue;
      }
      throw new Error(`FC host-network command failed: ${line}: ${msg}`);
    }
  }
  logger.info(
    `provisioned bridge ${cfg.bridgeName} (${cfg.bridgeCidr}, table ${cfg.table}, egress ${iface})`,
  );
}

/** Read-only health probe for one bridge. Never throws on a missing resource. */
export async function verifyBridge(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<BridgeHealth> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  const want = cfg.bridgeCidr.split('/')[0];
  const wantPrefix = Number(cfg.bridgeCidr.split('/')[1]);
  let bridgeExists = false;
  let bridgeUp = false;
  let addrPresent = false;
  let tablePresent = false;
  let baselineChainPresent = false;
  let tapIsolationPresent = false;
  const misses: string[] = [];

  try {
    const { stdout } = await runner({ bin: 'ip', args: ['-j', 'link', 'show', cfg.bridgeName] });
    const link = JSON.parse(stdout) as Array<{ operstate?: string; flags?: string[] }>;
    bridgeExists = link.length > 0;
    // A bridge with no enslaved TAP reports operstate DOWN + NO-CARRIER even
    // when administratively up — that's the normal post-provision state before
    // any microVM spawns. The administrative state is the IFF_UP flag in
    // `flags`; that's what we assert (operstate UP/UNKNOWN also counts, for a
    // bridge that happens to already have a carrier-bearing member).
    const adminUp = (link[0]?.flags ?? []).includes('UP');
    const operUp = link[0]?.operstate === 'UP' || link[0]?.operstate === 'UNKNOWN';
    bridgeUp = adminUp || operUp;
    if (!bridgeUp) misses.push(`${cfg.bridgeName} not up`);
  } catch {
    misses.push(`${cfg.bridgeName} does not exist`);
  }

  try {
    const { stdout } = await runner({ bin: 'ip', args: ['-j', 'addr', 'show', cfg.bridgeName] });
    const info = JSON.parse(stdout) as Array<{
      addr_info?: Array<{ local?: string; prefixlen?: number }>;
    }>;
    addrPresent = (info[0]?.addr_info ?? []).some(
      (a) => a.local === want && a.prefixlen === wantPrefix,
    );
    if (!addrPresent) misses.push(`${cfg.bridgeCidr} not assigned to ${cfg.bridgeName}`);
  } catch {
    misses.push(`could not read addrs on ${cfg.bridgeName}`);
  }

  try {
    await runner({ bin: 'nft', args: ['list', 'table', 'ip', cfg.table] });
    tablePresent = true;
  } catch {
    misses.push(`nft table ip ${cfg.table} missing`);
  }

  // A half-provisioned chain layout must read unhealthy rather than silently
  // accepting: without the baseline chain and its tail jump, the per-VM rules
  // are the ONLY thing in `forward`, so nothing NATs or drops for the subnet.
  try {
    const { stdout } = await runner({
      bin: 'nft',
      args: ['-j', 'list', 'chain', 'ip', cfg.table, 'forward'],
    });
    baselineChainPresent = forwardEndsInBaselineJump(stdout);
    if (!baselineChainPresent) {
      misses.push(`ip ${cfg.table} forward does not end in \`jump ${BASELINE_CHAIN}\``);
    }
  } catch {
    misses.push(`could not read chain ip ${cfg.table} forward`);
  }

  // Bridge port isolation is the only thing standing between two concurrent
  // tenants' VMs: their traffic is switched at L2 on this bridge and never
  // reaches the IP forward hook, so no nft rule can see it.
  try {
    const { stdout } = await runner({
      bin: 'ip',
      args: ['-d', '-j', 'link', 'show', 'master', cfg.bridgeName],
    });
    const unisolated = unisolatedTapNames(stdout);
    tapIsolationPresent = unisolated.length === 0;
    if (!tapIsolationPresent) {
      misses.push(`TAP(s) without port isolation on ${cfg.bridgeName}: ${unisolated.join(', ')}`);
    }
  } catch {
    misses.push(`could not read enslaved links on ${cfg.bridgeName}`);
  }

  const healthy =
    bridgeExists &&
    bridgeUp &&
    addrPresent &&
    tablePresent &&
    baselineChainPresent &&
    tapIsolationPresent;
  return {
    bridgeName: cfg.bridgeName,
    bridgeExists,
    bridgeUp,
    addrPresent,
    tablePresent,
    baselineChainPresent,
    tapIsolationPresent,
    healthy,
    detail: healthy ? 'healthy' : misses.join('; '),
  };
}

/**
 * True when the LAST rule of a `nft -j list chain … forward` listing is a jump
 * to {@link BASELINE_CHAIN}.
 *
 * Position is the assertion, not mere presence: a jump that is not last would
 * let the baseline's unconditional internet accept run before a per-VM
 * `denyAll` drop.
 */
export function forwardEndsInBaselineJump(nftJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(nftJson);
  } catch {
    return false;
  }
  const entries = (parsed as { nftables?: unknown[] })?.nftables;
  if (!Array.isArray(entries)) return false;
  const rules = entries
    .map((e) => (e as { rule?: { expr?: unknown[] } }).rule)
    .filter((r): r is { expr?: unknown[] } => r != null);
  const last = rules.at(-1);
  if (!last || !Array.isArray(last.expr)) return false;
  return last.expr.some((node) => {
    const jump = (node as { jump?: { target?: unknown } }).jump;
    return jump?.target === BASELINE_CHAIN;
  });
}

/**
 * Names of the kici-* TAPs enslaved to the bridge that are NOT port-isolated,
 * read from `ip -d -j link show master <bridge>`.
 *
 * Only kici-* TAPs are checked: an operator may legitimately enslave another
 * interface, and isolating it is not this module's business.
 */
export function unisolatedTapNames(ipJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ipJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const link of parsed) {
    const entry = link as {
      ifname?: string;
      linkinfo?: { info_slave_data?: { isolated?: unknown } };
    };
    const name = entry.ifname;
    if (typeof name !== 'string' || !name.startsWith('kici-')) continue;
    const isolated = entry.linkinfo?.info_slave_data?.isolated;
    // `ip -d -j` renders the flag as the boolean true or the string "on"
    // depending on iproute2 version.
    if (isolated !== true && isolated !== 'on') names.push(name);
  }
  return names;
}

/** Remove the bridge + its nft table. Leaves the host-scoped NM conf in place. */
export async function teardownBridge(
  cfg: FirecrackerBridgeConfig,
  opts: ExecOptions = {},
): Promise<void> {
  const runner = opts.runner ?? defaultRunner(opts.requireSudo ?? false);
  for (const spec of [
    { bin: 'nft', args: ['delete', 'table', 'ip', cfg.table] },
    { bin: 'ip', args: ['link', 'del', cfg.bridgeName] },
  ]) {
    try {
      await runner(spec);
    } catch (err) {
      logger.debug(`teardown skip ${spec.bin}: ${toErrorMessage(err)}`);
    }
  }
}

const HOST_IFACE_SENTINEL = '__HOST_IFACE__';

/** Serialize the provisioning command list into a dependency-free boot script. */
export function renderBootScript(cfg: FirecrackerBridgeConfig): string {
  const specs = buildBridgeCommands({ ...cfg, hostIface: HOST_IFACE_SENTINEL });
  const lines = specs.map((s) => {
    // nft table-delete and every DOCKER-USER iptables call are best-effort:
    // the table may not exist yet, and DOCKER-USER only exists when docker is
    // installed (and iptables may be absent entirely on a non-docker host).
    const benign =
      (s.bin === 'nft' && s.args[0] === 'delete' && s.args[1] === 'table') || s.bin === 'iptables';
    const argv = [s.bin, ...s.args]
      .map((tok) => (tok === HOST_IFACE_SENTINEL ? '"$HOST_IFACE"' : shellQuote(tok)))
      .join(' ');
    return benign ? `${argv} 2>/dev/null || true` : argv;
  });
  return [
    '#!/usr/bin/env bash',
    `# Generated by kici-admin firecracker --persist for bridge ${cfg.bridgeName}. Do not hand-edit.`,
    'set -euo pipefail',
    // Write the NM-unmanaged conf via a quoted heredoc so the multi-line
    // content lands verbatim (real newlines, no shell expansion). `printf '%s'`
    // would NOT interpret backslash escapes in its argument, so embedding
    // \n-escaped content there collapses the conf onto one line — a single
    // comment line NM ignores, leaving kici-* interfaces NM-managed on reboot.
    `cat > ${NM_CONF_PATH} <<'KICI_NM_EOF' || true`,
    NM_CONF_CONTENT.replace(/\n$/, ''),
    'KICI_NM_EOF',
    'HOST_IFACE=$(ip -j route show default | sed -n \'s/.*"dev":"\\([^"]*\\)".*/\\1/p\' | head -1)',
    'if [ -z "$HOST_IFACE" ]; then echo "no default-route iface" >&2; exit 1; fi',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Minimal POSIX-safe single-quote shell escaping for boot-script tokens.
 *
 * `*` is deliberately NOT in the bare-token allow-list: an `nft` arg like
 * `kici-*` (the iifname match) must reach nft literally, but an unquoted
 * `kici-*` would be glob-expanded by bash against the CWD. Tokens carrying any
 * shell metacharacter (incl. `*`, spaces, `{`/`;` from chain definitions) are
 * single-quoted so they pass through verbatim.
 */
function shellQuote(tok: string): string {
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(tok)) return tok;
  return `'${tok.replace(/'/g, `'\\''`)}'`;
}
