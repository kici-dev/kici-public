/**
 * Redaction primitives for diagnostic bundles.
 *
 * Both halves are pure — no filesystem, no archiver, no server graph — which
 * is why they live in core rather than beside the archive writer in
 * `@kici-dev/shared`: the `kici` CLI produces bundles too, and it may not
 * import the shared package (doing so pulls OTel, the AWS SDK, and pg into the
 * install closure of a `pnpm dlx kici` run).
 *
 * `redactConfig` is an allowlist over structured config; `scrubText` is a
 * denylist over free text. They catch different things and a bundle runs both.
 */

/**
 * Config field names that are safe to include unredacted.
 * Everything else gets replaced with "****".
 */
const SAFE_CONFIG_KEYS = new Set([
  'mode',
  'host',
  'port',
  'logLevel',
  'region',
  'environment',
  'name',
  'label',
  'labels',
  'enabled',
  'disabled',
  'timeout',
  'interval',
  'maxRetries',
  'retries',
  'workers',
  'concurrency',
  'maxConcurrency',
  'batchSize',
  'bufferSize',
  'warmPool',
  'cooldown',
  'type',
  'provider',
  'scaler',
  'driver',
  'backend',
  'protocol',
  'scheme',
  'path',
  'basePath',
  'metricsPath',
  'healthPath',
  'logFormat',
  'logFile',
  'logDir',
  'dataDir',
  'version',
  'debug',
  'verbose',
  'quiet',
  'tls',
  'cors',
  'rateLimiting',
  'maxConnections',
  'poolSize',
  'minPool',
  'maxPool',
  'idleTimeout',
  'connectTimeout',
  'requestTimeout',
  'shutdownTimeout',
  'gracefulShutdown',
]);

/**
 * Redact config values using allowlist approach.
 * Only known-safe fields are preserved; everything else becomes "****".
 */
export function redactConfig(obj: unknown, parentKey?: string): unknown {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactConfig(item, parentKey));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactConfig(value, key);
    }
    return result;
  }

  // Primitive values: check if the key is safe
  if (typeof obj === 'string' && parentKey && !SAFE_CONFIG_KEYS.has(parentKey)) {
    return '****';
  }

  // Numbers, booleans are always safe
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  // String with a safe key
  if (typeof obj === 'string' && parentKey && SAFE_CONFIG_KEYS.has(parentKey)) {
    return obj;
  }

  // Top-level string with no parent key -- redact
  if (typeof obj === 'string') {
    return '****';
  }

  return obj;
}

/**
 * A secret shape to mask, and how much of it may survive.
 *
 * `group` names the capture holding the secret itself, so a pattern can match
 * the surrounding context it needs to be sure (an `Authorization:` header, an
 * `X-Amz-Signature=` parameter) while masking only the credential. `full`
 * suppresses the trailing breadcrumb for a shape where no part of the match is
 * safe to keep.
 */
interface SecretPattern {
  re: RegExp;
  group?: number;
  full?: boolean;
}

/**
 * Below this length, a four-character breadcrumb discloses a meaningful
 * fraction of the secret, so the mask keeps nothing.
 */
const BREADCRUMB_MIN_LENGTH = 20;

/** Key names whose assigned value is a credential whatever its shape. */
const SECRET_KEY_NAMES =
  'api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|' +
  'private[_-]?key|credential|auth[_-]?token|session[_-]?key';

/**
 * The value half of a `key=value` credential.
 *
 * Deliberately "everything up to a delimiter" rather than an allowlist of
 * token characters: a real password contains punctuation, and an allowlist
 * both MISSES `password=A!bcdefgh` outright and — worse — masks only the head
 * of `password=Tr0ub4dor&3xyzzy`, leaving a partial secret that reads as
 * scrubbed. The delimiters are the characters that actually end a value in the
 * shapes we see: whitespace, a quote, and the JSON/YAML structural set.
 *
 * `&` and `*` are delimiters for two specific reasons. `&` separates query
 * parameters, and without it a logged presigned URL — the very thing this
 * feature mints — collapsed everything after `X-Amz-Credential=` into one
 * mask, destroying the date, expiry and signed-header list. `*` is the mask's
 * own character: without it this rule re-consumed a mask the dedicated X-Amz
 * rule had already placed, and swallowed the rest of the line with it.
 */
const SECRET_VALUE = `[^\\s"'\`,;)\\]}&*]{6,}`;

/**
 * Ordered secret-shape catalog.
 *
 * Structured shapes (a header, a query parameter, an assignment) come first:
 * they carry the context that makes a match certain, so letting a bare-token
 * pattern claim part of one first would leave the rest of the credential in
 * the clear. Bare-token shapes follow, each anchored on a prefix distinctive
 * enough that ordinary diagnostic text cannot match it.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // A private key block is worthless partially masked, and its trailing
  // characters are the PEM footer rather than key material.
  //
  // The body class excludes `-` on purpose. A lazy `[\s\S]*?` here rescans to
  // end-of-input at EVERY unterminated BEGIN marker, which is quadratic: 4.6s
  // on 1.4 MB, extrapolating to over an hour on the 50 MB MAX_LOG_BYTES
  // ceiling — and this runs synchronously inside the orchestrator and agent,
  // so it would wedge the event loop on log content we do not fully control.
  // Excluding `-` makes an unterminated block fail at the first `-` instead of
  // scanning the rest of the file; the length bound caps the rest.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,65536}-----END [A-Z ]*PRIVATE KEY-----/g,
    full: true,
  },
  // `[^\S\n]` is horizontal whitespace only: `\s*` would let the header match
  // across a newline and mask the first token of the following line.
  {
    re: /(Authorization:[^\S\n]*(?:Bearer|Basic|Token)[^\S\n]+)([A-Za-z0-9._~+/=-]{12,})/gi,
    group: 2,
  },
  // Session credentials, the sibling of the Authorization header above.
  //
  // Anchored to line start so ordinary prose — `failed to parse cookie:
  // unexpected token` — keeps its tail. The second form is the one structured
  // loggers actually emit, which the header rule alone never matched.
  { re: /^([^\S\n]*(?:Set-)?Cookie:[^\S\n]*)([^\n]{8,})/gim, group: 2 },
  { re: /("(?:set-)?cookie"[^\S\n]*:[^\S\n]*")([^"\n]{8,})/gi, group: 2 },
  {
    re: /(X-Amz-(?:Signature|Credential|Security-Token)=)([A-Za-z0-9%._~+/-]+)/gi,
    group: 2,
  },
  { re: /(ENC\[AES256_GCM,data:)([A-Za-z0-9+/=]+)/g, group: 2 },
  // The password in `scheme://user:pass@host`. Anchored on both the userinfo
  // colon and the `@`, so a plain URL carrying neither is untouched.
  { re: /(?<=:\/\/[^\s:@/]{1,256}:)[^\s@/]+(?=@)/g },
  {
    re: new RegExp(
      `((?:${SECRET_KEY_NAMES})["']?[^\\S\\n]*[=:][^\\S\\n]*["']?)(${SECRET_VALUE})`,
      'gi',
    ),
    group: 2,
  },
  // AKIA is a 4-char public prefix plus 16 of key material, so a last-4
  // breadcrumb would disclose a quarter of the secret half. Mask it whole.
  { re: /AKIA[0-9A-Z]{16}/g, full: true },
  // `github_pat_` is GitHub's current fine-grained default; `gh[pousr]_` are
  // the legacy shapes.
  { re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  // Bounded for the same reason the PEM body is: three unbounded runs over a
  // long stretch of matching characters with no dot backtrack quadratically —
  // measured 6s at 100 KB and 37s at 195 KB on the same synchronous
  // orchestrator/agent path, against a 50 MB log ceiling. A real JWT segment
  // is far below this bound.
  { re: /eyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}/g },
  // Credential families this repo actually mints: agent tokens (`kat_`),
  // Platform API keys and service accounts (`kici_sk_` / `kici_sa_`), personal
  // access tokens (`kici_pat_`), and cluster join tokens (`kici_join_v1.…`).
  { re: /kat_[A-Za-z0-9_-]{16,}/g },
  { re: /kici_(?:sk|sa|pat)_[A-Za-z0-9_-]{16,}/g },
  { re: /kici_join_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9]+/g },
  { re: /kici-local-[A-Za-z0-9]{16,}/g },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
];

/**
 * Replace one secret with a mask, keeping a last-4 breadcrumb when the secret
 * is long enough that four characters disclose little.
 *
 * The breadcrumb exists so a human reading the bundle can tell WHICH
 * credential a line referred to without learning the credential.
 */
function maskSecret(secret: string, full = false): string {
  if (full || secret.length < BREADCRUMB_MIN_LENGTH) return '***REDACTED***';
  return `***REDACTED:…${secret.slice(-4)}***`;
}

/**
 * Mask known secret shapes in free text.
 *
 * The allowlist redaction in `redactConfig` covers structured config, but log
 * lines and command output are free text: a credential logged into a message
 * survives config redaction untouched. Both the orchestrator's
 * `kici-admin debug-bundle` and the author-facing `kici report` bundle can be
 * shared with KiCI, so this is the last point at which a secret can be caught.
 *
 * Deliberately a denylist of shapes we can recognise with confidence, not an
 * attempt at completeness. A scrubber that masks everything destroys the
 * diagnostic value the bundle exists to carry, so ordinary text — run ids,
 * digests, metric names, versions, stack frames — is left byte-identical.
 * Redaction is best effort, and the bundle carries a notice saying so.
 *
 * Operates on whole text rather than a single line: a PEM private key block
 * spans several lines, and scrubbing line by line would never match it.
 */
export function scrubText(input: string): string {
  let out = input;
  for (const { re, group, full } of SECRET_PATTERNS) {
    out = out.replace(re, (match, ...rest) => {
      if (group === undefined) return maskSecret(match, full);
      const prefix = rest[group - 2] as string;
      const secret = rest[group - 1] as string;
      return `${prefix}${maskSecret(secret, full)}`;
    });
  }
  return out;
}
