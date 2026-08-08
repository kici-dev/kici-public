/**
 * Agent private API registry.
 *
 * Provides a typed, extensible request-response API over the existing agent WS
 * connection. Each method is registered with a role (read/write) for authorization.
 *
 * Adding a new API method:
 * 1. Add the typed method + return type in @kici-dev/sdk (api-types.ts)
 * 2. Call registry.register('namespace.method', 'read', handler) here
 *
 * The agent sends { type: 'agent.api.request', method, params } and receives
 * { type: 'agent.api.response', result?, error? } back.
 */

import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'agent-api' });

/** Authorization roles for API methods. */
export type ApiRole = 'read' | 'write';

/** Handler function for an API method. */
export type ApiHandler = (agentId: string, params: Record<string, unknown>) => Promise<unknown>;

/** Internal registration for a single API method. */
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
 * Registry for agent private API methods.
 *
 * Methods are dot-namespaced (e.g., 'infrastructure.list') and each has an
 * associated role. The orchestrator checks the caller's allowed roles before
 * invoking the handler.
 */
export class AgentApiRegistry {
  private readonly methods = new Map<string, ApiMethodEntry>();

  /**
   * Register an API method.
   *
   * @param method - Dot-namespaced method name (e.g., 'infrastructure.list')
   * @param role - Required role to call this method
   * @param handler - Async handler that receives agentId and params, returns result
   */
  register(method: string, role: ApiRole, handler: ApiHandler): void {
    if (this.methods.has(method)) {
      throw new Error(`API method '${method}' is already registered`);
    }
    this.methods.set(method, { role, handler });
    logger.info('API method registered', { method, role });
  }

  /**
   * Handle an API request.
   *
   * @param agentId - The calling agent's ID
   * @param method - Requested method name
   * @param params - Method parameters
   * @param allowedRoles - Roles the caller is authorized for
   * @returns The method's result
   * @throws Error if method not found or role not authorized
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

  /** Get all registered method names (for diagnostics). */
  getMethods(): string[] {
    return [...this.methods.keys()];
  }
}
