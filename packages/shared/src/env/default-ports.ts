/**
 * The `KICI_PORT` defaults of the services a host runs. Each service's config
 * schema takes its default from here, and `kici-admin` reads the same value
 * when an env file sets no `KICI_PORT`, so the two cannot disagree.
 */

/** The orchestrator's HTTP port (API, `/health`, `/ready`, WebSocket) when `KICI_PORT` is unset. */
export const ORCHESTRATOR_DEFAULT_PORT = 4000;

/** The agent's HTTP port (`/health`, `/ready`, `/metrics`) when `KICI_PORT` is unset. */
export const AGENT_DEFAULT_PORT = 8080;
