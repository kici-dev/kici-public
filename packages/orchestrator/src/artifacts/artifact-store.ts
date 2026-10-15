/**
 * User-facing artifacts layer wrapping CacheStorage + the `artifacts` DB table.
 *
 * Artifacts are named, immutable-per-run build deliverables, stored at
 * `artifacts/{runId}/{name}-{discriminator}.tar.gz` on the user-cache's
 * `CacheStorage` backend; one row per upload carries the size, sha256, and
 * `customer_id` (org quota-accounting scope). Immutability: the pre-mint
 * duplicate-name check here, with the DB `UNIQUE (run_id, name)` as backstop.
 *
 * Before minting a presigned PUT: per-artifact size cap, per-run count cap,
 * per-org byte quota, duplicate name — each a named `ArtifactRejectReason` the
 * agent surfaces verbatim. Caps, quota and TTL take a per-org `org_settings`
 * override, else the cluster-wide default.
 *
 * TTL: expired `ttlMs` after `created_at`, and then excluded from quota sums,
 * downloads and the dashboard listing — lazy like the user-cache TTL (no
 * active sweep; the object expires lazily via `CacheStorage`'s own TTL).
 */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import { ARTIFACT_NAME_MAX_LENGTH, checkArtifactName, toIsoString } from '@kici-dev/engine';
import type { ArtifactRejectReason } from '@kici-dev/engine';
import type { Database, ArtifactRow } from '../db/types.js';
import type { CacheStorage } from '../storage/types.js';
import { keyDiscriminator } from '../storage/key-discriminator.js';
import { ArtifactInternalFailure, artifactInvalidNameError } from './failure-messages.js';

const logger = createLogger({ prefix: 'artifact-store' });

/**
 * The presigned PUT never landed an object. Terminal, unlike a transient
 * storage/DB error (a retry would keep finding it absent), so it goes straight
 * back to the agent, which fails the workflow step.
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
 * Map a `completeUpload` failure onto a message safe for the agent, which runs
 * untrusted workflow code (the reason reaches the author's step logs).
 *
 * An invalid-name message is already safe (the schema's fixed detail) and
 * passes through. Object-missing keeps its own category, but not the storage
 * key its message embeds. Anything else collapses to one literal; the raw
 * exception stays in the orchestrator's own log.
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

const TAR_SUFFIX = '.tar.gz';

/**
 * Sanitize a path segment so a storage key can never escape the artifacts
 * namespace. An all-dots segment (`.`, `..`) is HTTP/S3 path-canonicalized away
 * and breaks the presigned signature, so it is prefixed (mirrors UserCache.seg).
 *
 * A defensive net for the server-generated run id only: names are validated
 * against `ArtifactNameSchema` first, so sanitizing one is the identity.
 * Sanitizing alone would be unsound — it is many-to-one (`a/b` and `a_b`).
 */
function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Storage key for a run's named artifact. Injective over names, so a second
 * upload can never silently overwrite the first while both rows keep their own
 * hash.
 *
 * The trailing discriminator, a hash of the EXACT name, keeps keys apart on a
 * CASE-INSENSITIVE namespace (the filesystem backend on macOS or Windows),
 * where `bundle` and `Bundle` would otherwise resolve to one file. Under case
 * folding it carries the whole separation, hence its width (see
 * `KEY_DISCRIMINATOR_LENGTH`). The readable stem lets an operator browsing the
 * bucket tell which artifact an object is. Hashing the sanitized name instead
 * would fold `a/b` and `a_b` back together.
 *
 * Changing this format does not strand existing artifacts: downloads read the
 * persisted `artifacts.storage_key`; only the grant and commit paths derive,
 * both at upload time.
 */
export function artifactStorageKey(runId: string, name: string): string {
  return `artifacts/${sanitizeSegment(runId)}/${sanitizeSegment(name)}-${keyDiscriminator(name)}${TAR_SUFFIX}`;
}

/** Per-org `org_settings` overrides; an undefined field uses the cluster default. */
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
  /** Free-text detail when no enforcement `reason` applies (a contract-violating name). */
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
  /** Presigned GET (`listForRunWithUrls`); omitted when the object is expired or gone. */
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
    maxBytes?: number;
    maxPerRun?: number;
    /** When unset, defaults apply. */
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

  /** Effective limits for an org: the `org_settings` override, else the default. */
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

  /** Cutoff time for TTL filtering: rows created before this are expired. */
  private cutoff(ttlMs: number): Date {
    return new Date(Date.now() - ttlMs);
  }

  /**
   * Grant or refuse a presigned PUT. Order: name contract → resolve limits →
   * size cap → duplicate name → per-run count cap → org quota. No URL is minted
   * for a request violating any gate.
   *
   * The name is checked here, not only in the SDK, because the agent runs
   * untrusted workflow code: a name bypassing the SDK check would be sanitized
   * onto another name's key, letting a second upload overwrite the first object
   * while both rows keep their own hash. A contract violation is not an
   * enforcement rejection, so it carries a free-text `error` and no `reason`.
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
        // Untrusted agent input: length-bounded, but logged so an operator sees
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
   * Commit a completed upload: write the metadata sidecar, then insert the row.
   * `UNIQUE (run_id, name)` (onConflict-do-nothing) backstops a racing duplicate
   * that slipped past the pre-mint check.
   *
   * The agent asserts neither key nor size: the key derives from the
   * server-resolved `runId` + `name`, the size is read back from storage.
   * Agents run untrusted code, so an echoed key could point a row at another
   * tenant's object, and a declared size could under-account the org quota (a
   * presigned PUT does not bind content length).
   *
   * The name is re-validated: a commit is its own inbound message, possibly for
   * a name never granted, and a non-conforming name would derive the key of a
   * *different*, already-committed artifact and record a second row against it.
   *
   * Throws `ArtifactInvalidNameError`, `ArtifactObjectMissingError`, or the
   * underlying storage / DB error. The caller reports it to the agent, which
   * fails the step rather than leaving a green run with no artifact.
   */
  async completeUpload(args: {
    customerId: string;
    runId: string;
    jobId: string;
    name: string;
    sha256: string;
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
   * A run's non-expired artifacts with a presigned GET each, newest first, for
   * the dashboard run-detail panel. A row whose object is gone keeps its
   * metadata with `downloadUrl` omitted rather than being dropped. Also reports
   * the presigned-URL expiry in seconds — the backend's `getUrl` signature TTL,
   * NOT the retention `ttlMs` — so the dashboard can refresh a URL before it
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
        createdAt: toIsoString(r.created_at),
        ...(downloadUrl ? { downloadUrl } : {}),
      });
    }
    return {
      artifacts: out,
      downloadUrlExpiresInSeconds: this.storage.presignedGetTtlSeconds(),
    };
  }
}
