/**
 * Which cluster-settings version each orchestrator in a cluster has applied,
 * compared with the version of the shared `cluster_settings` row.
 *
 * A worker reports the version of the snapshot it pulled, which is the one its
 * next spawn reads. A coordinator reports the version its settings reader
 * currently serves. Pure, because `kici-admin cluster-settings show` imports
 * it to validate and render the report the admin route builds.
 */
import { z } from 'zod';
import type { PeerInfo } from './peer-registry.js';

export const settingsPropagationStatusSchema = z.enum(['in-sync', 'behind', 'ahead']);
export type SettingsPropagationStatus = z.infer<typeof settingsPropagationStatusSchema>;
export const SettingsPropagationStatus = settingsPropagationStatusSchema.enum;

export const settingsPropagationRoleSchema = z.enum(['coordinator', 'worker']);
const Role = settingsPropagationRoleSchema.enum;

export const settingsPropagationEntrySchema = z
  .object({
    instanceId: z.string(),
    role: settingsPropagationRoleSchema,
    /** True for the coordinator that produced the report. */
    self: z.boolean(),
    connected: z.boolean(),
    appliedVersion: z.number().int().nonnegative(),
    status: settingsPropagationStatusSchema,
    /** ISO time of the last heartbeat; null for the reporting coordinator. */
    lastHeartbeatAt: z.string().nullable(),
    lastHeartbeatAgeMs: z.number().nonnegative().nullable(),
  })
  .passthrough();
export type SettingsPropagationEntry = z.infer<typeof settingsPropagationEntrySchema>;

export const settingsPropagationReportSchema = z
  .object({
    /** `cluster_settings.version`, read from the database for this report. */
    currentVersion: z.number().int().nonnegative(),
    /** Instance id of the coordinator that answered. */
    reportedBy: z.string(),
    generatedAt: z.string(),
    orchestrators: z.array(settingsPropagationEntrySchema),
  })
  .passthrough();
export type SettingsPropagationReport = z.infer<typeof settingsPropagationReportSchema>;

/** The peer-registry fields a report reads. */
export type PropagationPeer = Pick<
  PeerInfo,
  'instanceId' | 'role' | 'connected' | 'lastHeartbeatAt' | 'clusterSettingsVersion'
>;

/**
 * `ahead` means the row's version went backwards. A worker in that state never
 * pulls again, because it pulls only when a coordinator advertises a higher
 * version than its own.
 */
export function classifySettingsVersion(
  applied: number,
  current: number,
): SettingsPropagationStatus {
  if (applied === current) return SettingsPropagationStatus['in-sync'];
  return applied < current ? SettingsPropagationStatus.behind : SettingsPropagationStatus.ahead;
}

const ROLE_RANK: Record<PropagationPeer['role'], number> = { coordinator: 0, worker: 1 };

export function buildSettingsPropagationReport(input: {
  currentVersion: number;
  self: { instanceId: string; appliedVersion: number };
  peers: readonly PropagationPeer[];
  now: number;
}): SettingsPropagationReport {
  const { currentVersion, self, peers, now } = input;
  const selfEntry: SettingsPropagationEntry = {
    instanceId: self.instanceId,
    role: Role.coordinator,
    self: true,
    connected: true,
    appliedVersion: self.appliedVersion,
    status: classifySettingsVersion(self.appliedVersion, currentVersion),
    lastHeartbeatAt: null,
    lastHeartbeatAgeMs: null,
  };
  const peerEntries = peers
    .map((p): SettingsPropagationEntry => ({
      instanceId: p.instanceId,
      role: p.role,
      self: false,
      connected: p.connected,
      appliedVersion: p.clusterSettingsVersion,
      status: classifySettingsVersion(p.clusterSettingsVersion, currentVersion),
      lastHeartbeatAt: new Date(p.lastHeartbeatAt).toISOString(),
      lastHeartbeatAgeMs: Math.max(0, now - p.lastHeartbeatAt),
    }))
    .sort(
      (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.instanceId.localeCompare(b.instanceId),
    );
  return {
    currentVersion,
    reportedBy: self.instanceId,
    generatedAt: new Date(now).toISOString(),
    orchestrators: [selfEntry, ...peerEntries],
  };
}
