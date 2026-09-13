/**
 * The shape of the orchestrator's fault-injection policy.
 *
 * The policy's *implementation* is test-only and lives in `src/testing/`, which
 * is excluded from the npm tarball, the container image and the public mirror.
 * The type itself has to ship: three production modules (`app.ts`,
 * `orchestrator-core.ts`, `server.ts`) declare an optional `faultInjection`
 * field, so a projection without this file fails to typecheck with three
 * TS2307s. Only the declaration lives here — its one dependency is a type from
 * `@kici-dev/engine`, so nothing test-only is pulled along with it.
 */
import type { OrchCapabilities } from '@kici-dev/engine';

/**
 * The set of synthetic faults a test-only entrypoint can inject into the
 * orchestrator. Every field is optional: an absent field means "no fault at
 * this seam". A whole `undefined` policy means the orchestrator runs with no
 * fault injection at all.
 */
export interface OrchestratorFaultInjection {
  /**
   * Per-event-name fault map: while `event.attempts <= N`, the EventRouter
   * throws a synthetic dispatch error to drive the retry / DLQ path.
   */
  eventFailFirstN?: Record<string, number>;
  /**
   * Skip the S3 sentinel validation on cluster-identity bootstrap. Read
   * independently of `KICI_TEST_MODE` (matching today's behavior).
   */
  skipS3Sentinel?: boolean;
  /**
   * Predicate over an OIDC `audience`: when true, the *initial* provenance
   * mint fails transiently (defer), so an E2E can exercise the
   * deferred-attestation retry + per-run serve path.
   */
  initialMintFault?: (audience: string) => boolean;
  /**
   * Predicate over an OIDC `audience`: when true, the retrier's later re-mint
   * TERMINALLY REJECTS the audience, exercising the reject → gauge-exclusion →
   * re-arm cycle.
   */
  remintReject?: (audience: string) => boolean;
  /**
   * Invoked by `handleRerunRequest` before `onRerun`, so an HA E2E can make
   * the first coordinator slow enough that the Platform relay fails over.
   */
  beforeRerun?: () => Promise<void>;
  /**
   * Transform the advertised capability manifest — used to reproduce an older
   * / sourceless orchestrator that predates a given dashboard capability.
   */
  capabilitiesTransform?: (c: OrchCapabilities) => OrchCapabilities;
}
