/**
 * Barrel export for the cluster coordination module.
 *
 * All cluster-related functionality is exported from this single entry point
 * for clean imports in server.ts and standalone.ts.
 */

export { PeerRegistry } from './peer-registry.js';
export type { PeerInfo, PeerAgentInfo, PeerRegistryOptions } from './peer-registry.js';
export { PeerClient } from './peer-client.js';
export type { PeerClientOptions } from './peer-client.js';
export { PeerAuthCoordinator } from './peer-auth-coordinator.js';
export type { AuthDecision, RejectionAction } from './peer-auth-coordinator.js';
export { createPeerHandler } from './peer-handler.js';
export type { PeerHandlerDeps } from './peer-handler.js';
export {
  PeerCredentialStore,
  readCredentialFile,
  writeCredentialFile,
} from './peer-credentials.js';
export type { PeerCredential, CredentialFileData } from './peer-credentials.js';
export { RaftNode } from './raft.js';
export type { RaftRole } from './raft.js';
export { RaftStateStore } from './raft-state.js';
export type { RaftPersistentState } from './raft-state.js';
export { OrphanRecovery } from './orphan-recovery.js';
export { RunCoordinator } from './coordinator.js';
export type { RunContext, JobToRoute, RouteResult } from './coordinator.js';
export { createClusterHealthRoutes } from './health-api.js';
export type { ClusterHealthRoutesDeps } from './health-api.js';
