/**
 * Egress filtering for nested job containers.
 *
 * A job container joins the dedicated `kici-jobs` bridge, behind the same
 * RFC1918 + cloud-metadata nftables drops the scaler installs for agent
 * containers (one shared `@kici-dev/shared` builder). On the runtime's default
 * bridge a step could reach `169.254.169.254` and the host's private network.
 *
 * `network: 'host'` (`KICI_SANDBOX_NETWORK=host` or a per-job
 * `sandbox: { network: 'host' }` grant) bypasses this by construction.
 */

import type Docker from 'dockerode';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  addHostIsolationRules,
  addIsolationRules,
  buildHostAccessRuleOps,
  buildIsolationRuleOps,
  ensureKiciTable,
  JOB_NETWORK_SUBNET,
  readForwardChain,
  readInputChain,
  removeIsolationRules,
  validateNftablesAvailability,
  type NetworkPolicy,
} from '@kici-dev/shared/net';

const logger = createLogger({ prefix: 'job-network' });

export const JOB_NETWORK_NAME = 'kici-jobs';
/**
 * Distinct from the scaler's agent network. Lives in `@kici-dev/shared/net`
 * because the Firecracker host provisioner, which cannot import the agent,
 * must recognise its rules to leave them alone.
 */
export { JOB_NETWORK_SUBNET };
/** Gateway for {@link JOB_NETWORK_NAME} — the one destination the rules allow. */
export const JOB_NETWORK_GATEWAY = '172.31.0.1';

const DNS_PORT = 53;

/**
 * What a job container may reach ON the host: DNS on the bridge gateway only.
 * A job talks to the agent through `docker exec` and holds no agent
 * credentials. The DNS carve-out is required: rootful podman runs its resolver
 * on the gateway, so without it no name resolves (Docker resolves inside the
 * container's netns).
 *
 * Derived from agent config with no widening argument. A `NetworkPolicy` passed
 * to {@link applyJobEgressRules} governs only the FORWARD hook; its `hostAccess`
 * is deliberately ignored, since a job naming its own host reachability is the
 * escape hatch this boundary closes, and this signature makes that structural.
 */
export function resolveJobHostAccess(gateway: string = JOB_NETWORK_GATEWAY): string[] {
  return [`${gateway}:${DNS_PORT}`];
}

/**
 * Ensure the `kici-jobs` network, the nftables table and the subnet's egress
 * drops, before any job container exists. Drops key on the subnet, not a
 * container address, so a customer image's `ENTRYPOINT` never runs unfiltered.
 *
 * Returns whether filtering is in force. Without `nft` or `NET_ADMIN` (commonly
 * a rootless agent) it warns and degrades to no rules rather than refusing jobs:
 * `kici-admin agent install` is compat-protected, and requiring NET_ADMIN would
 * break existing rootless installs with no additive path. The scaler makes the
 * same trade-off for agent containers.
 */
export async function ensureJobNetwork(docker: Docker): Promise<boolean> {
  try {
    // The nft probe runs FIRST, so a host that cannot filter never joins the
    // bridge: that would buy nothing and fails jobs on a runtime that cannot
    // create the network.
    await validateNftablesAvailability();
    await ensureKiciTable();
    await ensureJobSubnetEgressRules(JOB_NETWORK_SUBNET, JOB_NETWORK_GATEWAY);

    // An existing bridge (hand-made, or from a version with another range)
    // hands out ITS subnet, which the set above misses. Cover that range too:
    // refusing returns false, which leaves the container on the default bridge
    // with no filtering at all.
    const actual = await ensureJobNetworkExists(docker);
    if (actual.subnet !== JOB_NETWORK_SUBNET || actual.gateway !== JOB_NETWORK_GATEWAY) {
      logger.warn(
        `Job network ${JOB_NETWORK_NAME} carries ${actual.subnet} (gateway ${actual.gateway}), ` +
          `not the expected ${JOB_NETWORK_SUBNET} (gateway ${JOB_NETWORK_GATEWAY}). ` +
          'Installing the egress drops for the range it actually uses. Remove the network ' +
          'to have the agent recreate it with the expected addressing.',
      );
      await ensureJobSubnetEgressRules(actual.subnet, actual.gateway);
    }
    return true;
  } catch (err) {
    logger.warn(
      `Job-container egress filtering DISABLED: ${toErrorMessage(err)} ` +
        'Job containers reach the host private network and the cloud metadata endpoint. ' +
        'Grant the agent --cap-add=NET_ADMIN (and install nftables), or set ' +
        'KICI_SANDBOX_NETWORK_ISOLATION=false to silence this.',
    );
    return false;
  }
}

/**
 * Install the default RFC1918 + cloud-metadata drops for the whole job subnet.
 *
 * Keyed on `ip saddr <subnet>`, so it covers every container that will ever
 * join, and a customer `ENTRYPOINT` never runs before its rules land.
 *
 * The per-container rules from {@link applyJobEgressRules} sit above these:
 * `addIsolationRules` inserts at the chain head, so a per-job `accept` beats the
 * subnet `drop`. A repair puts a fresh subnet set above already-running jobs'
 * per-container rules; harmless while those carry no policy (identical
 * verdicts), but a per-job policy would have to reinstall its rules after a repair.
 *
 * Idempotent (it runs once per job): the install is skipped only when the chain
 * holds EVERY expected rule. Each rule is its own `nft insert`, so an
 * interrupted install leaves a partial set; skipping on one match would leave
 * the host permanently missing, say, the `10.0.0.0/8` drop. Matching the exact
 * {@link buildIsolationRuleOps} text also rejects the scaler's near-misses in
 * this chain: a per-container rule at `172.31.0.10`, and an operator allowlist
 * naming this subnet as a DESTINATION.
 *
 * Repair reinstalls the whole set rather than deleting first: the fresh block
 * lands complete at the chain head, so a running container is never unfiltered
 * even briefly; the superseded rules below are inert duplicates.
 */
async function ensureJobSubnetEgressRules(subnet: string, gateway: string): Promise<void> {
  await ensureJobSubnetHostRules(subnet, gateway);

  const expected = buildIsolationRuleOps(['ip', 'saddr', subnet], gateway).map((tokens) =>
    tokens.join(' '),
  );

  const chain = await readForwardChain();
  const present = new Set(
    (chain ?? '').split('\n').map((line) => line.trim().replace(/\s*# handle \d+$/, '')),
  );
  if (chain !== null && expected.every((rule) => present.has(rule))) return;

  await addIsolationRules(subnet, gateway, undefined, 'saddr');
  logger.info(`Installed default egress drops for ${subnet}`);
}

/**
 * Install the subnet-wide host-access rules (what a job may reach ON the host,
 * not through it), keyed on the subnet for the same pre-start reason.
 *
 * Idempotent against the chain text, not remove-then-insert: removing first
 * would drop protection from every running job container for the duration,
 * failing open.
 */
async function ensureJobSubnetHostRules(subnet: string, gateway: string): Promise<void> {
  const hostAccess = resolveJobHostAccess(gateway);
  const expected = buildHostAccessRuleOps(['ip', 'saddr', subnet], hostAccess).map((tokens) =>
    tokens.join(' '),
  );

  const chain = await readInputChain();
  const present = new Set(
    (chain ?? '').split('\n').map((line) => line.trim().replace(/\s*# handle \d+$/, '')),
  );
  if (chain !== null && expected.every((rule) => present.has(rule))) return;

  await addHostIsolationRules(subnet, hostAccess, 'saddr');
  logger.info(`Installed default host-access rules for ${subnet}`);
}

/** The address range a job container on the bridge actually gets. */
interface JobNetworkAddressing {
  subnet: string;
  gateway: string;
}

/**
 * Create the `kici-jobs` bridge, tolerating a concurrent creator.
 *
 * Returns the addressing containers will get: canonical when this call created
 * it, otherwise what the present network carries, the only honest key for the
 * drop set. Keying on the constant would leave a differently addressed network
 * outside the set and reopen the pre-start window.
 */
async function ensureJobNetworkExists(docker: Docker): Promise<JobNetworkAddressing> {
  const canonical = { subnet: JOB_NETWORK_SUBNET, gateway: JOB_NETWORK_GATEWAY };

  // The name filter matches substrings, so the exact name is re-checked.
  const existing = await findJobNetwork(docker);
  if (existing) return existing;

  try {
    await docker.createNetwork({
      Name: JOB_NETWORK_NAME,
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: JOB_NETWORK_SUBNET, Gateway: JOB_NETWORK_GATEWAY }] },
      Labels: { 'kici-managed': 'true' },
    });
    logger.info(`Created job network ${JOB_NETWORK_NAME}`);
    return canonical;
  } catch (err) {
    // 409: another agent or job created it first; read back what THEY made.
    if ((err as { statusCode?: number }).statusCode === 409) {
      return (await findJobNetwork(docker)) ?? canonical;
    }
    throw err;
  }
}

/** The present `kici-jobs` network's addressing, or `undefined` when absent. */
async function findJobNetwork(docker: Docker): Promise<JobNetworkAddressing | undefined> {
  const found = (await docker.listNetworks({ filters: { name: [JOB_NETWORK_NAME] } })).find(
    (n) => n.Name === JOB_NETWORK_NAME,
  );
  if (!found) return undefined;

  // No IPAM config: fall back to canonical; the per-container rules still land.
  const config = (found.IPAM?.Config ?? [])[0] as { Subnet?: string; Gateway?: string } | undefined;
  return {
    subnet: config?.Subnet ?? JOB_NETWORK_SUBNET,
    gateway: config?.Gateway ?? JOB_NETWORK_GATEWAY,
  };
}

/**
 * Apply per-container egress rules once the container has an IP.
 *
 * Not the control: the subnet drops already cover this container. The
 * per-container set is where a future per-job policy (allowlist or `denyAll`)
 * keys on one address.
 *
 * Returns the IP the rules key on, for teardown. A missing IP is logged, not
 * thrown: the job still runs behind the subnet drops, and the operator sees why.
 */
export async function applyJobEgressRules(
  docker: Docker,
  containerId: string,
  policy: NetworkPolicy | undefined,
): Promise<string | undefined> {
  const info = await docker.getContainer(containerId).inspect();
  const containerIp = info.NetworkSettings?.Networks?.[JOB_NETWORK_NAME]?.IPAddress as
    string | undefined;
  if (!containerIp) {
    logger.warn(
      'Could not determine job container IP — no per-container egress rules applied. ' +
        'A container on the kici-jobs bridge stays behind the subnet drops; one that is not ' +
        'on that bridge has unfiltered egress.',
      { containerId },
    );
    return undefined;
  }

  await addIsolationRules(containerIp, JOB_NETWORK_GATEWAY, policy, 'saddr');
  await addHostIsolationRules(containerIp, resolveJobHostAccess(), 'saddr');
  return containerIp;
}

/**
 * Remove the per-container rules at teardown. Never throws, so cleanup cannot
 * fail a finished job; a leaked set is keyed on an IP the network reuses, so it
 * is reported at `warn`.
 */
export async function removeJobEgressRules(containerIp: string | undefined): Promise<void> {
  if (!containerIp) return;
  try {
    await removeIsolationRules(containerIp);
  } catch (err) {
    logger.warn('Failed to remove job-container egress rules', {
      containerIp,
      error: toErrorMessage(err),
    });
  }
}
