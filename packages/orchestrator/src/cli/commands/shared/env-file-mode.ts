/**
 * Mode for a `kici-admin` service env file. Both installers' files carry credentials (the
 * orchestrator's KICI_SECRET_KEY, KICI_DATABASE_URL and KICI_PLATFORM_TOKEN; the
 * agent's KICI_AGENT_TOKEN), so neither may be group- or world-readable. The
 * same mode guards the temporary Postgres password file in
 * `orchestrator-service/install.ts` and the peer credential file in
 * `cluster/peer-credentials.ts`.
 *
 * POSIX-only: on Windows Node toggles the read-only attribute and changes no
 * ACL, so a Windows install restricts the folder instead (`restrictEnvFileAccess`,
 * `cli/service/windows-acl.ts`).
 */
export const ENV_FILE_MODE = 0o600;
