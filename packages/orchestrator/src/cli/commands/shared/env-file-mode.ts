/**
 * Permissions for a service env file written by `kici-admin`.
 *
 * Both installers write a file that carries credentials — the orchestrator's
 * holds KICI_SECRET_KEY, KICI_DATABASE_URL and KICI_PLATFORM_TOKEN, the
 * agent's holds KICI_AGENT_TOKEN — so neither may be group- or
 * world-readable. The same mode guards the temporary Postgres password file in
 * `orchestrator-service/install.ts` and the peer credential file in
 * `cluster/peer-credentials.ts`.
 *
 * The guarantee is POSIX-only. Node maps a mode onto Windows by toggling the
 * read-only attribute and changes no ACL, so a Windows install must restrict
 * the file itself.
 */
export const ENV_FILE_MODE = 0o600;
