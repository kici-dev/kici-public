/**
 * Resource request and limit types for jobs and scalers.
 *
 * Single source of truth — re-exported from the engine barrel and consumed by:
 * - SDK (`Job` / `JobOptions` `resources` field)
 * - compiler (compile-time validation + lockfile emission)
 * - orchestrator (scaler accounting + backend enforcement)
 * - dashboard (read-only display)
 *
 * Shape is K8s-style requests/limits split:
 * - `requests` drive the scheduler's cap math (per-scaler / per-orch / per-machine).
 * - `limits` drive kernel-side enforcement (Docker memory + nanoCpus, FC memSizeMib + vcpuCount,
 *   optional bare-metal systemd-run scope).
 *
 * Mirroring rule (applied at the orchestrator's resolve step):
 * - request-only ⇒ limit = request
 * - limit-only ⇒ request = limit
 * - neither ⇒ scaler default
 * - nothing anywhere ⇒ 0/0 (job counts toward agent-count cap only)
 */

import { z } from 'zod';

/**
 * A single resource specification (cpus + memory).
 *
 * - `cpus`: fractional cores (e.g., 1.5 means 1.5 cores).
 * - `memory`: container-style suffix (e.g., "2g", "512m", "1024k").
 *   No K8s "Mi/Gi" units — one parser, one format across the codebase.
 */
export interface ResourceSpec {
  /** CPU in fractional cores. */
  cpus?: number;
  /** Memory limit, e.g. "2g", "512m", "1024k". */
  memory?: string;
}

/**
 * Per-job resource request (declared in workflow source, threaded through to scaler).
 *
 * `requests` drive scheduling math (cap aggregation).
 * `limits` drive kernel-side enforcement of the spawned agent.
 */
export interface ResourceRequest {
  /** Requests drive the scheduler's cap math (per-scaler / per-orch / per-machine). */
  requests?: ResourceSpec;
  /** Limits drive kernel enforcement (Docker memory + nanoCpus, FC memSizeMib + vcpuCount, optional bare-metal systemd-run scope). */
  limits?: ResourceSpec;
}

/**
 * Zod schema for a single resource spec (cpus + memory).
 */
export const resourceSpecSchema = z
  .object({
    cpus: z.number().positive().max(256).optional(),
    memory: z.string().optional(),
  })
  .strict();

/**
 * Zod schema for the nested request/limit form.
 */
export const resourceRequestNestedSchema = z
  .object({
    requests: resourceSpecSchema.optional(),
    limits: resourceSpecSchema.optional(),
  })
  .strict();

/**
 * Memory string units supported across the codebase.
 *
 * Mirrors `parseMemoryString` in `packages/orchestrator/src/scaler/config.ts` —
 * keep both in sync. Hoisted here so the compiler (browser-safe) can validate
 * memory strings at compile time without depending on the orchestrator package.
 */
const MEMORY_FORMAT_RE = /^(\d+(?:\.\d+)?)\s*([kmgKMG])$/;

/**
 * Parse a memory string with unit suffix to bytes.
 *
 * Supported formats:
 * - "512m" or "512M" -> 536870912 (512 * 1024^2)
 * - "2g" or "2G" -> 2147483648 (2 * 1024^3)
 * - "1024k" or "1024K" -> 1048576 (1024 * 1024)
 *
 * @throws Error if the format is invalid
 */
export function parseMemoryString(memory: string): number {
  const match = memory.match(MEMORY_FORMAT_RE);
  if (!match) {
    throw new Error(
      `Invalid memory format: "${memory}". Expected format like "512m", "2g", or "1024k".`,
    );
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'k':
      return Math.floor(value * 1024);
    case 'm':
      return Math.floor(value * 1024 * 1024);
    case 'g':
      return Math.floor(value * 1024 * 1024 * 1024);
    default:
      throw new Error(`Unknown memory unit: "${unit}"`);
  }
}

/**
 * Validate a `ResourceRequest` literal (e.g., from compile-time SDK input).
 *
 * Checks:
 * - `memory` strings parse via `parseMemoryString`.
 * - `cpus` are positive numbers ≤ 256 (max practical scaler).
 * - When both `requests` and `limits` are set on the same dimension,
 *   `requests <= limits` (a request that exceeds its own limit is nonsensical).
 *
 * Throws on the first violation with a descriptive error.
 */
export function validateResourceRequest(req: ResourceRequest): void {
  resourceRequestNestedSchema.parse(req);

  for (const side of ['requests', 'limits'] as const) {
    const spec = req[side];
    if (!spec) continue;
    if (spec.memory !== undefined) {
      // Throws if invalid format.
      parseMemoryString(spec.memory);
    }
    if (spec.cpus !== undefined && spec.cpus <= 0) {
      throw new Error(`resources.${side}.cpus must be > 0 (got ${spec.cpus})`);
    }
  }

  const requests = req.requests;
  const limits = req.limits;
  if (requests && limits) {
    if (requests.cpus !== undefined && limits.cpus !== undefined && requests.cpus > limits.cpus) {
      throw new Error(
        `resources.requests.cpus (${requests.cpus}) must not exceed resources.limits.cpus (${limits.cpus})`,
      );
    }
    if (requests.memory !== undefined && limits.memory !== undefined) {
      const reqBytes = parseMemoryString(requests.memory);
      const limBytes = parseMemoryString(limits.memory);
      if (reqBytes > limBytes) {
        throw new Error(
          `resources.requests.memory (${requests.memory}) must not exceed resources.limits.memory (${limits.memory})`,
        );
      }
    }
  }
}
