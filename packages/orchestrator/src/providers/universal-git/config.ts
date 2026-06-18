/**
 * Zod schema + preset table for universal-git source configuration.
 *
 * A universal-git source is a `generic_webhook_sources` row with a non-null
 * `git_config` column. The config carries everything the orchestrator needs
 * to build clone URLs, fetch lock files, parse changed files, and issue
 * clone credentials against a user-supplied git server (Forgejo / Gitea /
 * Gogs / GitLab repo-webhook / plain GitHub repo-webhook).
 *
 * Presets expand into full `payloadPaths` for each supported forge; custom
 * (preset-less) configs spell out the paths explicitly. Adding a new forge
 * means adding a row to `UNIVERSAL_GIT_PRESETS` — no new migration, no
 * provider code changes.
 */

import { z } from 'zod';

/**
 * Preset identifier. Picks a canonical payload-path bundle for a forge whose
 * webhook shape is close enough to GitHub's that JSONPath extraction works
 * verbatim.
 */
export const UniversalGitPreset = z.enum([
  'forgejo',
  'gitea',
  'gogs',
  'gitlab-repo',
  'github-repo',
  'custom',
]);
export type UniversalGitPreset = z.infer<typeof UniversalGitPreset>;

/**
 * Credential type for the git clone step. `pat` and `basic` both use HTTPS
 * Basic auth (PAT is Basic auth with user=`x-access-token` or user=`oauth2`
 * depending on forge); `ssh` uses an SSH key + `GIT_SSH_COMMAND`.
 */
export const UniversalGitCredentialType = z.enum(['pat', 'basic', 'ssh']);
export type UniversalGitCredentialType = z.infer<typeof UniversalGitCredentialType>;

/**
 * SSH host-key verification policy. `accept-new` auto-trusts the forge on
 * first connection (safe default for private ops but logs a one-time
 * warning). `pinned` requires `sshKnownHostsPem` and refuses any host key
 * that doesn't match — use for production-grade supply-chain hardening.
 */
export const SshHostKeyPolicy = z.enum(['accept-new', 'pinned']);
export type SshHostKeyPolicy = z.infer<typeof SshHostKeyPolicy>;

/**
 * Reference to a secret in the orchestrator's secret store. Resolved at
 * dispatch time via `SecretResolver.resolveNamed()`. The secret itself lives
 * at scope `__source__/<sourceId>`, key = `credentialRef.key`, optionally
 * in a specific backend via `credentialRef.store` (defaults to `pg`).
 */
export const CredentialRefSchema = z.object({
  key: z.string().min(1).describe('Secret key name within the source scope'),
  store: z.string().min(1).optional().describe('Backend name (default: pg)'),
});
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/**
 * Payload extraction paths (JSONPath). Each preset supplies canonical values;
 * `custom` requires all fields to be set explicitly.
 */
export const UniversalGitPayloadPathsSchema = z.object({
  /** Path to the repository identifier (e.g. `$.repository.full_name`). */
  repoIdentifier: z.string().min(1),
  /** Path to the git ref on a push event (e.g. `$.ref`). */
  pushRef: z.string().min(1),
  /** Path to the head commit SHA on a push event (e.g. `$.after`). */
  pushSha: z.string().min(1),
  /** Path to the default branch on the repository (e.g. `$.repository.default_branch`). */
  defaultBranch: z.string().min(1),
  /** Path to the `added` files array on a push event. */
  commitsAdded: z.string().min(1),
  /** Path to the `modified` files array on a push event. */
  commitsModified: z.string().min(1),
  /** Path to the `removed` files array on a push event. */
  commitsRemoved: z.string().min(1),
});
export type UniversalGitPayloadPaths = z.infer<typeof UniversalGitPayloadPathsSchema>;

/**
 * Header-to-event-name mapping. Most forges send an `X-Event-Type`-style
 * header; a few send different names for the same semantic event (e.g.
 * Gogs sends `push` while GitLab sends `Push Hook`). The universal-git
 * normalizer uses this map to collapse forge-specific values into the
 * kici-internal `push` / `pull_request` / ... event names.
 */
export const EventMappingSchema = z.object({
  push: z.array(z.string()).min(1).describe('Incoming event-type values that map to "push"'),
  pullRequest: z
    .array(z.string())
    .min(1)
    .describe('Incoming event-type values that map to "pull_request"'),
});
export type EventMapping = z.infer<typeof EventMappingSchema>;

/**
 * Complete universal-git configuration stored in `generic_webhook_sources.git_config`.
 *
 * Validation refinements (enforced by Zod):
 *   - `credentialType === 'ssh'` implies `credentialUser` is unused (ignored).
 *   - `sshHostKeyPolicy === 'pinned'` requires `sshKnownHostsPem`.
 *   - `preset === 'custom'` requires explicit `payloadPaths` and `eventMapping`.
 *   - Non-custom presets ignore caller-supplied `payloadPaths` / `eventMapping`
 *     in favour of the preset defaults (see `expandUniversalGitConfig`).
 */
export const UniversalGitConfigSchema = z
  .object({
    /** Preset tag. Selects canonical payload paths + event mapping. */
    preset: UniversalGitPreset,

    /**
     * Template URL the orchestrator substitutes `{owner}`, `{name}`, and
     * `{repo}` into when building the clone URL for the agent. Example:
     * `https://forgejo.example.com/{owner}/{name}.git`. Required.
     */
    gitUrlTemplate: z
      .string()
      .min(1)
      .describe('Clone URL template with {owner} / {name} / {repo} placeholders'),

    /** Reference to the secret the agent will use to clone. */
    credentialRef: CredentialRefSchema,

    /** Credential shape selector. Drives how the agent wires auth at clone time. */
    credentialType: UniversalGitCredentialType,

    /**
     * Username for Basic / PAT auth. Optional — PATs on most forges don't
     * care about the username (we default to `x-access-token` for parity
     * with GitHub App tokens). Ignored when `credentialType === 'ssh'`.
     */
    credentialUser: z.string().optional(),

    /** SSH host-key verification policy. Required when `credentialType === 'ssh'`. */
    sshHostKeyPolicy: SshHostKeyPolicy.default('accept-new'),

    /**
     * Pinned SSH host-key bundle in OpenSSH known_hosts format. Required iff
     * `sshHostKeyPolicy === 'pinned'`. May include multiple lines for forges
     * with multiple host keys (Ed25519 + RSA etc).
     */
    sshKnownHostsPem: z.string().optional(),

    /**
     * Payload extraction paths. Auto-filled from the preset when `preset !==
     * 'custom'`. Callers supplying `preset: 'custom'` MUST include this.
     */
    payloadPaths: UniversalGitPayloadPathsSchema.optional(),

    /** Header-to-event-name mapping. Auto-filled from preset for non-custom. */
    eventMapping: EventMappingSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.sshHostKeyPolicy === 'pinned' && !val.sshKnownHostsPem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sshKnownHostsPem'],
        message: 'sshKnownHostsPem is required when sshHostKeyPolicy is "pinned"',
      });
    }
    if (val.preset === 'custom') {
      if (!val.payloadPaths) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payloadPaths'],
          message: 'payloadPaths is required when preset is "custom"',
        });
      }
      if (!val.eventMapping) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['eventMapping'],
          message: 'eventMapping is required when preset is "custom"',
        });
      }
    }
  });
export type UniversalGitConfig = z.infer<typeof UniversalGitConfigSchema>;

/**
 * Canonical preset definitions. Expanded into full `payloadPaths` +
 * `eventMapping` by `expandUniversalGitConfig`. Every forge in this table
 * emits push / PR payloads that are structurally identical to GitHub's at
 * the fields we care about (repository.full_name, commits[].added, etc.).
 *
 * `webhookEventHeader` is the HTTP header each forge sets on outbound
 * webhook deliveries to communicate the event type. It is consumed by the
 * generic webhook ingester (`generic_webhook_sources.event_type_header`) to
 * classify the event before passing it to the universal-git normalizer. The
 * source manager auto-populates the row's `event_type_header` from this
 * field when an operator picks a preset and does not override the header
 * explicitly.
 */
export const UNIVERSAL_GIT_PRESETS: Record<
  Exclude<UniversalGitPreset, 'custom'>,
  {
    payloadPaths: UniversalGitPayloadPaths;
    eventMapping: EventMapping;
    webhookEventHeader: string;
  }
> = {
  forgejo: {
    payloadPaths: {
      repoIdentifier: '$.repository.full_name',
      pushRef: '$.ref',
      pushSha: '$.after',
      defaultBranch: '$.repository.default_branch',
      commitsAdded: '$.commits[*].added[*]',
      commitsModified: '$.commits[*].modified[*]',
      commitsRemoved: '$.commits[*].removed[*]',
    },
    eventMapping: {
      push: ['push'],
      pullRequest: ['pull_request'],
    },
    webhookEventHeader: 'X-Gitea-Event',
  },
  gitea: {
    payloadPaths: {
      repoIdentifier: '$.repository.full_name',
      pushRef: '$.ref',
      pushSha: '$.after',
      defaultBranch: '$.repository.default_branch',
      commitsAdded: '$.commits[*].added[*]',
      commitsModified: '$.commits[*].modified[*]',
      commitsRemoved: '$.commits[*].removed[*]',
    },
    eventMapping: {
      push: ['push'],
      pullRequest: ['pull_request'],
    },
    webhookEventHeader: 'X-Gitea-Event',
  },
  gogs: {
    payloadPaths: {
      repoIdentifier: '$.repository.full_name',
      pushRef: '$.ref',
      pushSha: '$.after',
      defaultBranch: '$.repository.default_branch',
      commitsAdded: '$.commits[*].added[*]',
      commitsModified: '$.commits[*].modified[*]',
      commitsRemoved: '$.commits[*].removed[*]',
    },
    eventMapping: {
      push: ['push'],
      pullRequest: ['pull_request'],
    },
    webhookEventHeader: 'X-Gogs-Event',
  },
  'gitlab-repo': {
    payloadPaths: {
      repoIdentifier: '$.project.path_with_namespace',
      pushRef: '$.ref',
      pushSha: '$.after',
      defaultBranch: '$.project.default_branch',
      commitsAdded: '$.commits[*].added[*]',
      commitsModified: '$.commits[*].modified[*]',
      commitsRemoved: '$.commits[*].removed[*]',
    },
    eventMapping: {
      push: ['Push Hook', 'push'],
      pullRequest: ['Merge Request Hook', 'merge_request'],
    },
    webhookEventHeader: 'X-Gitlab-Event',
  },
  'github-repo': {
    payloadPaths: {
      repoIdentifier: '$.repository.full_name',
      pushRef: '$.ref',
      pushSha: '$.after',
      defaultBranch: '$.repository.default_branch',
      commitsAdded: '$.commits[*].added[*]',
      commitsModified: '$.commits[*].modified[*]',
      commitsRemoved: '$.commits[*].removed[*]',
    },
    eventMapping: {
      push: ['push'],
      pullRequest: ['pull_request'],
    },
    webhookEventHeader: 'X-GitHub-Event',
  },
};

/**
 * Resolve the canonical webhook event-type header for a preset. Returns
 * `null` when the preset is `custom` (operator must supply the header
 * explicitly via `eventTypeHeader`).
 */
export function presetWebhookEventHeader(preset: UniversalGitPreset): string | null {
  if (preset === 'custom') return null;
  return UNIVERSAL_GIT_PRESETS[preset].webhookEventHeader;
}

/**
 * Expand a validated `UniversalGitConfig` into a form where `payloadPaths`
 * and `eventMapping` are always populated. Non-custom presets pull from
 * `UNIVERSAL_GIT_PRESETS`; `custom` passes through the caller-supplied
 * values (Zod has already enforced that both are present).
 */
export function expandUniversalGitConfig(config: UniversalGitConfig): UniversalGitConfig & {
  payloadPaths: UniversalGitPayloadPaths;
  eventMapping: EventMapping;
} {
  if (config.preset === 'custom') {
    return {
      ...config,
      payloadPaths: config.payloadPaths!,
      eventMapping: config.eventMapping!,
    };
  }
  const preset = UNIVERSAL_GIT_PRESETS[config.preset];
  return {
    ...config,
    payloadPaths: preset.payloadPaths,
    eventMapping: preset.eventMapping,
  };
}

/**
 * Parse a raw value (e.g. `git_config` JSONB from the DB) into a validated
 * `UniversalGitConfig`. Returns `null` when the input is null/undefined;
 * throws a ZodError on any other invalid shape.
 */
export function parseUniversalGitConfig(raw: unknown): UniversalGitConfig | null {
  if (raw === null || raw === undefined) return null;
  return UniversalGitConfigSchema.parse(raw);
}

/**
 * Safe-parse variant. Returns `{ ok: true, config }` on success, or
 * `{ ok: false, error }` on validation failure. Null/undefined inputs
 * produce `{ ok: true, config: null }`.
 */
export function safeParseUniversalGitConfig(
  raw: unknown,
): { ok: true; config: UniversalGitConfig | null } | { ok: false; error: z.ZodError } {
  if (raw === null || raw === undefined) return { ok: true, config: null };
  const parsed = UniversalGitConfigSchema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data };
  return { ok: false, error: parsed.error };
}
