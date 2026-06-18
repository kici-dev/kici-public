/**
 * Diagnostic check registry.
 *
 * Exports the array of all diagnostic check functions
 * in the order they should be displayed.
 */

import type { DiagnosticCheck } from '../types.js';
import { checkDbConnectivity } from './db.js';
import { checkWsToPlatform } from './ws.js';
import { checkAgentConnectivity } from './agents.js';
import { checkDiskSpace } from './disk.js';
import { checkConfigValidity } from './config.js';
import { checkCertificateExpiry } from './certs.js';
import { checkScalerProvisioning } from './scaler.js';
import { checkFirecrackerNetwork } from './firecracker-network.js';

/** All diagnostic checks in display order. */
export const defaultChecks: DiagnosticCheck[] = [
  checkDbConnectivity,
  checkWsToPlatform,
  checkAgentConnectivity,
  checkDiskSpace,
  checkConfigValidity,
  checkCertificateExpiry,
  checkScalerProvisioning,
  checkFirecrackerNetwork,
];

export {
  checkDbConnectivity,
  checkWsToPlatform,
  checkAgentConnectivity,
  checkDiskSpace,
  checkConfigValidity,
  checkCertificateExpiry,
  checkScalerProvisioning,
  checkFirecrackerNetwork,
};
