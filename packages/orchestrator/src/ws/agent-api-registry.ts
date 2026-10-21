/**
 * Agent private API: request-response over the existing agent WS connection. Each
 * method is registered with a role (read/write) for authorization.
 *
 * Adding a new API method:
 * 1. Add the typed method + return type in @kici-dev/sdk (api-types.ts)
 * 2. Call registry.register('namespace.method', 'read', handler) here
 *
 * The agent sends { type: 'agent.api.request', method, params } and receives
 * { type: 'agent.api.response', result?, error? } back. The error text reaches the
 * workflow author only for the typed rejections below (an unknown method, a
 * denied role, a handler's refusal); any other failure becomes a fixed string.
 */

import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'agent-api' });

export type ApiRole = 'read' | 'write';

export type ApiHandler = (agentId: string, params: Record<string, unknown>) => Promise<unknown>;

interface ApiMethodEntry {
  role: ApiRole;
  handler: ApiHandler;
}

/**
 * The caller named a method the registry does not know.
 *
 * A deliberate, bounded rejection: its message names only the method the caller
 * itself sent, so the agent WS handler may forward it verbatim to the workflow
 * author instead of replacing it with a safe fixed string.
 */
export class UnknownApiMethodError extends Error {
  constructor(method: string) {
    super(`Unknown API method '${method}'`);
    this.name = 'UnknownApiMethodError';
  }
}

/**
 * A handler refused the request for a reason the caller may read.
 *
 * A deliberate, bounded rejection: a handler throws it only with a message
 * written for the workflow author (it names the caller's own job, repository
 * or context, and never another org or an internal detail), so the agent WS
 * handler forwards it verbatim instead of replacing it with a safe fixed
 * string.
 */
export class AgentApiRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentApiRefusalError';
  }
}

/**
 * The caller is not authorized for the role the requested method requires.
 *
 * A deliberate, bounded rejection: its message names only the caller's own
 * method and roles, so the agent WS handler may forward it verbatim to the
 * workflow author instead of replacing it with a safe fixed string.
 */
export class ApiRoleDeniedError extends Error {
  constructor(method: string, requiredRole: ApiRole, allowedRoles: ApiRole[]) {
    super(
      `Method '${method}' requires '${requiredRole}' role, caller only has [${allowedRoles.join(', ')}]`,
    );
    this.name = 'ApiRoleDeniedError';
  }
}

/**
 * Methods are dot-namespaced (e.g., 'infrastructure.list'). The orchestrator checks the
 * caller's allowed roles before invoking the handler.
 */
export class AgentApiRegistry {
  private readonly methods = new Map<string, ApiMethodEntry>();

  /** Throws when `method` is already registered. */
  register(method: string, role: ApiRole, handler: ApiHandler): void {
    if (this.methods.has(method)) {
      throw new Error(`API method '${method}' is already registered`);
    }
    this.methods.set(method, { role, handler });
    logger.info('API method registered', { method, role });
  }

  /**
   * @throws UnknownApiMethodError / ApiRoleDeniedError if the method is not found or
   *   the caller lacks its role
   */
  async handle(
    agentId: string,
    method: string,
    params: Record<string, unknown>,
    allowedRoles: ApiRole[],
  ): Promise<unknown> {
    const entry = this.methods.get(method);
    if (!entry) {
      throw new UnknownApiMethodError(method);
    }

    if (!allowedRoles.includes(entry.role)) {
      throw new ApiRoleDeniedError(method, entry.role, allowedRoles);
    }

    return entry.handler(agentId, params);
  }

  /** For diagnostics. */
  getMethods(): string[] {
    return [...this.methods.keys()];
  }
}
