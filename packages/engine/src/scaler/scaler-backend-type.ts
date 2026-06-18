import { z } from 'zod';

/**
 * Scaler backend type identifiers.
 *
 * Enumerates the agent provisioning backends supported by the orchestrator's
 * auto-scaler module. Each backend implements the ScalerBackend interface.
 * Access values: ScalerBackendType.enum.container, ScalerBackendType.enum.firecracker, etc.
 */
export const ScalerBackendType = z.enum(['container', 'bare-metal', 'firecracker', 'kubernetes']);
export type ScalerBackendType = z.infer<typeof ScalerBackendType>;
