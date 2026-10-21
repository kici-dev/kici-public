import type { DiagnosticCheck } from '../types.js';
import { checkDbConnectivity } from './db.js';
import { checkBackupFreshness } from './backup.js';
import { checkRunHistoryRetention } from './retention.js';
import { checkWsToPlatform } from './ws.js';
import { checkAgentConnectivity } from './agents.js';
import { checkDiskSpace } from './disk.js';
import { checkConfigValidity } from './config.js';
import { checkCertificateExpiry } from './certs.js';
import { checkScalerProvisioning } from './scaler.js';
import { checkFirecrackerNetwork } from './firecracker-network.js';
import { checkCompileSchema } from './compile-schema.js';

/** All diagnostic checks in display order. */
export const defaultChecks: DiagnosticCheck[] = [
  checkDbConnectivity,
  checkBackupFreshness,
  checkRunHistoryRetention,
  checkWsToPlatform,
  checkAgentConnectivity,
  checkDiskSpace,
  checkConfigValidity,
  checkCertificateExpiry,
  checkScalerProvisioning,
  checkFirecrackerNetwork,
  checkCompileSchema,
];

export {
  checkDbConnectivity,
  checkBackupFreshness,
  checkRunHistoryRetention,
  checkWsToPlatform,
  checkAgentConnectivity,
  checkDiskSpace,
  checkConfigValidity,
  checkCertificateExpiry,
  checkScalerProvisioning,
  checkFirecrackerNetwork,
};
