/**
 * User-facing artifacts layer wrapping CacheStorage + the `artifacts` DB table.
 *
 * Artifacts are named, immutable-per-run build deliverables. Storage layout:
 * `artifacts/{runId}/{name}-{discriminator}.tar.gz` on the same `CacheStorage`
 * backend the user-cache uses; one row per upload carries the size, sha256,
 * and `customer_id` (org quota-accounting scope). Immutability is enforced at
 * two layers: the pre-mint duplicate-name check here AND the DB `UNIQUE
 * (run_id, name)` constraint as a backstop.
 *
 * Enforcement (before minting a presigned PUT): per-artifact size cap, per-run
 * count cap, per-org byte quota, duplicate name — each maps to a named
 * `ArtifactRejectReason` the agent surfaces verbatim. The size cap, count cap,
 * byte quota, and TTL each take a per-org `org_settings` override when set,
 * falling back to the cluster-wide default otherwise.
 *
 * TTL: an artifact is considered expired `ttlMs` after `created_at` (per-org
 * override or cluster default). Expired artifacts are excluded from quota sums,
 * download resolution, and the dashboard listing — a lazy model mirroring the
 * user-cache TTL (no active sweep; the backing object also expires lazily via
 * `CacheStorage`'s own TTL).
 */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import { ARTIFACT_NAME_MAX_LENGTH, checkArtifactName } from '@kici-dev/engine';
import type { ArtifactRejectReason } from '@kici-dev/engine';
import type { Database, ArtifactRow } from '../db/types.js';
import type { CacheStorage } from '../storage/types.js';
import { keyDiscriminator } from '../storage/key-discriminator.js';
import { ArtifactInternalFailure, artifactInvalidNameError } from './failure-messages.js';

const logger = createLogger({ prefix: 'artifact-store' });

/**
 * The presigned PUT never landed an object, so there is nothing to record.
 * Distinct from a transient storage/DB error: a caller retrying the commit
 * would keep finding the object absent, so this failure is terminal and is
 * reported straight back to the agent (which fails the workflow step).
 */
export class ArtifactObjectMissingError extends Error {
  constructor(readonly storageKey: string) {
    super(`Artifact object is missing from storage: ${storageKey}`);
    this.name = 'ArtifactObjectMissingError';
  }
}

/**
 * The requested artifact name violates the shared name contract. Terminal: the
 * name is fixed for the life of the request, so a retry would fail identically.
 */
export class ArtifactInvalidNameError extends Error {
  constructor(detail: string) {
    super(artifactInvalidNameError(detail));
    this.name = 'ArtifactInvalidNameError';
  }
}

/**
 * Map a `completeUpload` failure onto a message safe to send to the agent — which
 * runs untrusted workflow code, so the reason reaches the workflow author and its
 * step logs.
 *
 * An invalid-name error already carries a safe message: its constructor formats
 * the schema's own fixed detail, so it passes through unchanged. An object-missing
 * error is a genuinely actionable terminal case and keeps its own category, but
 * the storage key its message embeds does not travel. Anything else is an internal
 * failure the author cannot act on, so it collapses to one literal; the raw
 * exception stays in the orchestrator's own log line.
 */
export function classifyArtifactCommitFailure(err: unknown): string {
  if (err instanceof ArtifactInvalidNameError) return err.message;
  if (err instanceof ArtifactObjectMissingError) return ArtifactInternalFailure.commitObjectMissing;
  return ArtifactInternalFailure.commitFailed;
}

/** Cluster-wide default per-org artifact byte quota: 20 GiB. */
export const DEFAULT_ARTIFACT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
/** Cluster-wide default per-artifact TTL: 30 days. */
export const DEFAULT_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Cluster-wide default per-artifact size cap: 1 GiB. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 1 * 1024 * 1024 * 1024;
/** Cluster-wide default per-run artifact count cap. */
export const DEFAULT_ARTIFACT_MAX_PER_RUN = 50;

/** Tarball suffix for committed artifacts. */
const TAR_SUFFIX = '.tar.gz';

/**
 * Sanitize a path segment so a storage key can never escape the artifacts
 * namespace. An all-dots segment (`.`, `..`) is HTTP/S3 path-canonicalized away
 * and breaks the presigned signature, so it is prefixed (mirrors UserCache.seg).
 *
 * This is a defensive net for the server-generated run id, not the mechanism
 * that keeps artifact names apart: because a name is validated against
 * `ArtifactNameSchema` before it ever gets here, sanitizing it is always the
 * identity. Relying on sanitization alone would be unsound — it is many-to-one,
 * so `a/b` and `a_b` would address the same object.
 */
function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Storage key for a run's named artifact.
 *
 * Injective over names: distinct names always produce distinct keys, so a
 * second upload can never silently overwrite the first while both rows keep
 * their own hash.
 *
 * The trailing discriminator is a hash of the exact name, and it is what keeps
 * the keys apart on a CASE-INSENSITIVE object namespace — the filesystem
 * backend on a macOS or Windows host. There `bundle` and `Bundle` would
 * otherwise be two keys resolving to one file; because their discriminators
 * differ, the keys differ by more than case and stay two objects. That is why
 * the discriminator is wide (see `KEY_DISCRIMINATOR_LENGTH`): under case
 * folding it carries the whole separation on its own. The readable stem is kept
 * so an operator browsing the bucket can still tell which artifact an object
 * is.
 *
 * Hashing the EXACT name rather than the sanitized one is deliberate:
 * sanitizing is many-to-one, so a discriminator over its output would fold
 * `a/b` and `a_b` back together.
 *
 * Changing this format does not strand existing artifacts — the key is
 * persisted in `artifacts.storage_key` and the download paths read that column
 * rather than re-deriving. Only the grant and commit paths derive, and both do
 * so at upload time.
 */
export function artifactStorageKey(runId: string, name: string): string {
  return `artifacts/${sanitizeSegment(runId)}/${sanitizeSegment(name)}-${keyDiscriminator(name)}${TAR_SUFFIX}`;
}

/**
 * Per-org override of the artifact limits, read from `org_settings`. Each field
 * is optional; an undefined field falls back to the cluster-wide default.
 */
export interface ArtifactOrgLimits {
  quotaBytes?: number;
  ttlMs?: number;
  maxBytes?: number;
  maxPerRun?: number;
}

/** Resolves the per-org artifact limits (e.g. an `org_settings` read). */
export type ArtifactOrgLimitsReader = (customerId: string) => Promise<ArtifactOrgLimits>;

/** Outcome of a begin-upload grant request. */
export interface ArtifactBeginUploadResult {
  outcome: 'granted' | 'rejected';
  uploadUrl?: string;
  storageKey?: string;
  reason?: ArtifactRejectReason;
  /**
   * Free-text rejection detail carried when no enforcement `reason` applies —
   * today, a name that violates the artifact-name contract.
   */
  error?: string;
}

/** Outcome of a download lookup. */
export interface ArtifactDownloadResult {
  outcome: 'found' | 'not_found';
  downloadUrl?: string;
  sizeBytes?: number;
  sha256?: string;
}

/** A run's artifact as surfaced to the dashboard. */
export interface ArtifactListEntry {
  name: string;
  jobId: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  /**
   * Presigned GET for the backing object. Present on the run-detail listing
   * (`listForRunWithUrls`); omitted when the object could not be resolved
   * (expired / gone).
   */
  downloadUrl?: string;
}

export class ArtifactStore {
  private readonly storage: CacheStorage;
  private readonly db: Kysely<Database>;
  private readonly defaultQuotaBytes: number;
  private readonly defaultTtlMs: number;
  private readonly maxBytes: number;
  private readonly maxPerRun: number;
  private readonly orgLimitsReader?: ArtifactOrgLimitsReader;

  constructor(opts: {
    storage: CacheStorage;
    db: Kysely<Database>;
    /** Cluster-wide default quota (env default). */
    quotaBytes?: number;
    /** Cluster-wide default TTL (env default). */
    ttlMs?: number;
    /** Per-artifact size cap. */
    maxBytes?: number;
    /** Per-run artifact count cap. */
    maxPerRun?: number;
    /** Per-org override reader (org_settings). When unset, defaults apply. */
    orgLimitsReader?: ArtifactOrgLimitsReader;
  }) {
    this.storage = opts.storage;
    this.db = opts.db;
    this.defaultQuotaBytes = opts.quotaBytes ?? DEFAULT_ARTIFACT_QUOTA_BYTES;
    this.defaultTtlMs = opts.ttlMs ?? DEFAULT_ARTIFACT_TTL_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
    this.maxPerRun = opts.maxPerRun ?? DEFAULT_ARTIFACT_MAX_PER_RUN;
    this.orgLimitsReader = opts.orgLimitsReader;
  }

  /**
   * Resolve the effective quota, TTL, per-artifact size cap, and per-run count
   * cap for an org. Each value is the per-org `org_settings` override when set,
   * otherwise the cluster-wide default.
   */
  private async resolveLimits(
    customerId: string,
  ): Promise<{ quotaBytes: number; ttlMs: number; maxBytes: number; maxPerRun: number }> {
    if (!this.orgLimitsReader) {
      return {
        quotaBytes: this.defaultQuotaBytes,
        ttlMs: this.defaultTtlMs,
        maxBytes: this.maxBytes,
        maxPerRun: this.maxPerRun,
      };
    }
    let limits: ArtifactOrgLimits = {};
    try {
      limits = await this.orgLimitsReader(customerId);
    } catch (err) {
      logger.warn('artifact org-limits lookup failed — using cluster defaults', {
        customerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      quotaBytes: limits.quotaBytes ?? this.defaultQuotaBytes,
      ttlMs: limits.ttlMs ?? this.defaultTtlMs,
      maxBytes: limits.maxBytes ?? this.maxBytes,
      maxPerRun: limits.maxPerRun ?? this.maxPerRun,
    };
  }

  /** ISO cutoff for TTL filtering: rows created before this are expired. */
  private cutoff(ttlMs: number): Date {
    return new Date(Date.now() - ttlMs);
  }

  /**
   * Grant or refuse a presigned PUT for a named artifact. Order: name contract →
   * resolve limits → size cap → duplicate name → per-run count cap → org quota.
   * The size cap and per-run count cap are the resolved per-org override when
   * set, otherwise the cluster-wide default. No presigned URL is minted for a
   * request that would violate any gate.
   *
   * The name is checked first, and here rather than only in the SDK, because the
   * agent runs untrusted customer workflow code: a name that bypassed the SDK
   * check would be sanitized onto another name's storage key, letting a second
   * upload overwrite the first object while both rows keep their own hash. A
   * contract violation is not an enforcement rejection, so it carries a
   * free-text `error` and no `reason`.
   */
  async beginUpload(args: {
    customerId: string;
    runId: string;
    name: string;
    declaredSizeBytes: number;
  }): Promise<ArtifactBeginUploadResult> {
    const { customerId, runId, name, declaredSizeBytes } = args;

    const nameIssue = checkArtifactName(name);
    if (nameIssue !== null) {
      logger.warn('artifact upload rejected for a non-conforming name', {
        runId,
        // The name is untrusted agent input, so it is length-bounded before it
        // reaches the log; an operator triaging the rejection still needs to see
        // what was actually sent.
        name: name.slice(0, ARTIFACT_NAME_MAX_LENGTH),
        issue: nameIssue,
      });
      return { outcome: 'rejected', error: artifactInvalidNameError(nameIssue) };
    }

    const { quotaBytes, ttlMs, maxBytes, maxPerRun } = await this.resolveLimits(customerId);

    if (declaredSizeBytes > maxBytes) return { outcome: 'rejected', reason: 'size_cap' };

    const existing = await this.db
      .selectFrom('artifacts')
      .select('id')
      .where('run_id', '=', runId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (existing) return { outcome: 'rejected', reason: 'duplicate_name' };

    const cutoff = this.cutoff(ttlMs);

    const runCount = await this.db
      .selectFrom('artifacts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('run_id', '=', runId)
      .where('created_at', '>', cutoff)
      .executeTakeFirst();
    if (Number(runCount?.n ?? 0) >= maxPerRun) return { outcome: 'rejected', reason: 'run_cap' };

    const orgSum = await this.db
      .selectFrom('artifacts')
      .select((eb) => eb.fn.sum<string>('size_bytes').as('total'))
      .where('customer_id', '=', customerId)
      .where('created_at', '>', cutoff)
      .executeTakeFirst();
    const orgTotal = Number(orgSum?.total ?? 0);
    if (orgTotal + declaredSizeBytes > quotaBytes)
      return { outcome: 'rejected', reason: 'org_quota' };

    const key = artifactStorageKey(runId, name);
    const uploadUrl = await this.storage.getUploadUrl(key);
    return { outcome: 'granted', uploadUrl, storageKey: key };
  }

  /**
   * Commit a completed upload: write the object metadata sidecar, then insert
   * the DB row. The `UNIQUE (run_id, name)` constraint (via onConflict-do-nothing)
   * is the immutability backstop for a racing duplicate that slipped past the
   * pre-mint check.
   *
   * Neither agent-supplied value is trusted: the storage key is re-derived from
   * the server-resolved `runId` + `name`, and the recorded size is the real byte
   * size of the stored object read back from the storage backend. Agents run
   * untrusted customer workflow code, so an echoed key could otherwise point a
   * row at another tenant's object, and a declared size could under-account the
   * per-org quota (a presigned PUT does not bind content length).
   *
   * The name is re-validated here, not only at `beginUpload`: a commit is its
   * own inbound message, so an agent can send one for a name it never got a
   * grant for. Without the check, a non-conforming name would derive the
   * storage key of a *different*, already-committed artifact and record a second
   * row against that same object with its own hash.
   *
   * Throws when the commit cannot be recorded — `ArtifactInvalidNameError` for a
   * name that violates the contract, `ArtifactObjectMissingError` when the
   * presigned PUT never landed an object, or the underlying storage / DB error
   * otherwise. The caller reports the failure back to the agent, which fails the
   * workflow step rather than leaving a green run with no artifact.
   */
  async completeUpload(args: {
    customerId: string;
    runId: string;
    jobId: string;
    name: string;
    /** Agent-declared size. Advisory — the stored object is stat'd instead. */
    sizeBytes: number;
    sha256: string;
    /** Agent-echoed key. Ignored — the key is re-derived server-side. */
    storageKey: string;
  }): Promise<void> {
    const nameIssue = checkArtifactName(args.name);
    if (nameIssue !== null) {
      logger.warn('artifact commit rejected for a non-conforming name', {
        runId: args.runId,
        // Length-bounded for the same reason as the upload path above.
        name: args.name.slice(0, ARTIFACT_NAME_MAX_LENGTH),
        issue: nameIssue,
      });
      throw new ArtifactInvalidNameError(nameIssue);
    }

    const derivedKey = artifactStorageKey(args.runId, args.name);
    if (args.storageKey !== derivedKey) {
      logger.warn('artifact complete storageKey mismatch — using server-derived key', {
        runId: args.runId,
        name: args.name,
        wireKey: args.storageKey,
        derivedKey,
      });
    }

    // Verify the object exists and record its real size (the org quota sums the
    // stored size_bytes, so an unverified size is a quota-accounting hole).
    const realSize = await this.storage.getObjectSize(derivedKey);
    if (realSize === null) {
      logger.error('artifact complete for a missing object', {
        runId: args.runId,
        name: args.name,
        derivedKey,
      });
      throw new ArtifactObjectMissingError(derivedKey);
    }
    if (realSize !== args.sizeBytes) {
      logger.warn('artifact declared size does not match the stored object', {
        runId: args.runId,
        name: args.name,
        declaredSizeBytes: args.sizeBytes,
        realSizeBytes: realSize,
      });
    }

    // Presigned PUTs write only the data object; initMeta writes the metadata
    // sidecar CacheStorage.getUrl requires (mirrors the cache/provenance flow).
    await this.storage.initMeta(derivedKey);
    await this.db
      .insertInto('artifacts')
      .values({
        id: randomUUID(),
        customer_id: args.customerId,
        run_id: args.runId,
        job_id: args.jobId,
        name: args.name,
        size_bytes: realSize,
        sha256: args.sha256,
        storage_key: derivedKey,
      })
      .onConflict((oc) => oc.columns(['run_id', 'name']).doNothing())
      .execute();
    logger.info('artifact committed', {
      runId: args.runId,
      name: args.name,
      sizeBytes: realSize,
    });
  }

  /** Load a single artifact row (any TTL state) for a run + name. */
  private async loadRow(runId: string, name: string): Promise<ArtifactRow | undefined> {
    return this.db
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .where('name', '=', name)
      .executeTakeFirst();
  }

  private isExpired(row: ArtifactRow, ttlMs: number): boolean {
    const createdMs = new Date(row.created_at).getTime();
    return Date.now() - createdMs > ttlMs;
  }

  /**
   * Resolve a named artifact of a run to a presigned GET + its size/sha256, or
   * `not_found` when the name was never uploaded, has expired, or its backing
   * object is gone.
   */
  async download(args: {
    customerId: string;
    runId: string;
    name: string;
  }): Promise<ArtifactDownloadResult> {
    const { ttlMs } = await this.resolveLimits(args.customerId);
    const row = await this.loadRow(args.runId, args.name);
    if (!row || this.isExpired(row, ttlMs)) return { outcome: 'not_found' };
    const url = await this.storage.getUrl(row.storage_key, ttlMs);
    if (!url) return { outcome: 'not_found' };
    return {
      outcome: 'found',
      downloadUrl: url,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
    };
  }

  /** ISO string for a row's created_at (Date or already-string). */
  private createdAtIso(createdAt: Date | string): string {
    return createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  }

  /** Load a run's non-expired artifact rows, newest first, given the org TTL. */
  private async loadRunRows(runId: string, ttlMs: number): Promise<ArtifactRow[]> {
    return this.db
      .selectFrom('artifacts')
      .selectAll()
      .where('run_id', '=', runId)
      .where('created_at', '>', this.cutoff(ttlMs))
      .orderBy('created_at', 'desc')
      .execute();
  }

  /**
   * List a run's non-expired artifacts with a presigned GET per entry, newest
   * first — the shape the dashboard run-detail panel renders. Resolves the org
   * TTL once, then mints one presigned URL per row; a row whose backing object
   * is gone lists its metadata with `downloadUrl` omitted rather than being
   * dropped. Also reports the presigned-URL expiry (seconds) — the storage
   * backend's `getUrl` signature TTL, NOT the artifact-retention `ttlMs` — so
   * the dashboard can refresh a rendered `downloadUrl` before its signature
   * expires.
   */
  async listForRunWithUrls(
    customerId: string,
    runId: string,
  ): Promise<{ artifacts: ArtifactListEntry[]; downloadUrlExpiresInSeconds: number }> {
    const { ttlMs } = await this.resolveLimits(customerId);
    const rows = await this.loadRunRows(runId, ttlMs);
    const out: ArtifactListEntry[] = [];
    for (const r of rows) {
      const downloadUrl = (await this.storage.getUrl(r.storage_key, ttlMs)) ?? undefined;
      out.push({
        name: r.name,
        jobId: r.job_id,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        createdAt: this.createdAtIso(r.created_at),
        ...(downloadUrl ? { downloadUrl } : {}),
      });
    }
    return {
      artifacts: out,
      downloadUrlExpiresInSeconds: this.storage.presignedGetTtlSeconds(),
    };
  }
}
