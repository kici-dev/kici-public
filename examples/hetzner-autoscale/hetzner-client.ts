/**
 * Thin Hetzner Cloud REST client — create / delete / list-by-label servers.
 *
 * A minimal `fetch` wrapper over the Hetzner Cloud API
 * (`https://api.hetzner.cloud/v1`), so the reaper (`reap.ts`) needs no cloud SDK
 * and no install. KiCI ships no provider-specific code: autoscaling talks to a
 * cloud through workflows and scripts like this one, which you own and adapt.
 *
 * Give it a token for a project that holds only the servers you want managed,
 * so a mistake can never reach unrelated infrastructure.
 */

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';

/** A Hetzner Cloud server as returned by the list/detail endpoints (subset). */
export interface HetznerServer {
  id: number;
  name: string;
  /** RFC3339 creation timestamp (e.g. `2026-08-16T00:00:00+00:00`). */
  created: string;
  labels: Record<string, string>;
}

export interface CreateServerOpts {
  name: string;
  server_type: string;
  image: string;
  /** cloud-init user_data (installs + starts the agent). */
  user_data?: string;
  /** Resource labels — every teardown layer keys off these. */
  labels?: Record<string, string>;
  location?: string;
  /** SSH key ids / names to inject (optional; the agent uses a token, not SSH). */
  ssh_keys?: Array<string | number>;
}

type FetchImpl = typeof fetch;

export class HetznerClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  // Plain fields, not constructor parameter properties: Node's built-in type
  // stripping rejects parameter properties, and this file runs under `node`.
  constructor(token: string, baseUrl: string = HETZNER_API_BASE, fetchImpl: FetchImpl = fetch) {
    if (!token) {
      throw new Error('HetznerClient requires a non-empty API token');
    }
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // A DELETE may legitimately return 204 with no body.
    const text = await res.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        // A non-JSON body (e.g. an HTML/plaintext error page from a gateway or
        // CDN in front of the API) must not mask the HTTP status: keep the raw
        // text so the status-based error below still fires with a useful message
        // instead of throwing an opaque SyntaxError.
        json = text;
      }
    }
    return { status: res.status, json };
  }

  /** Create a server. Returns its numeric id. */
  async createServer(opts: CreateServerOpts): Promise<{ id: number }> {
    const { status, json } = await this.request('POST', '/servers', opts);
    if (status < 200 || status >= 300) {
      throw new Error(`Hetzner createServer failed (HTTP ${status}): ${JSON.stringify(json)}`);
    }
    const server = (json as { server?: { id?: number } }).server;
    if (!server || typeof server.id !== 'number') {
      throw new Error(`Hetzner createServer returned no server id: ${JSON.stringify(json)}`);
    }
    return { id: server.id };
  }

  /** Delete a server by id. A 404 (already gone) is treated as success. */
  async deleteServer(id: number): Promise<void> {
    const { status, json } = await this.request('DELETE', `/servers/${id}`);
    if (status === 404) return; // already gone — idempotent success
    if (status < 200 || status >= 300) {
      throw new Error(
        `Hetzner deleteServer(${id}) failed (HTTP ${status}): ${JSON.stringify(json)}`,
      );
    }
  }

  /**
   * List servers matching a Hetzner `label_selector` (e.g.
   * `kici-managed==hetzner-autoscale` or `kici-agent-id==a1`). An empty selector
   * lists every server in the project (used by the whole-project sweep). Follows
   * pagination.
   */
  async listByLabel(selector = ''): Promise<HetznerServer[]> {
    const servers: HetznerServer[] = [];
    let page = 1;
    // Hetzner caps per_page at 50; loop until the last page.
    for (;;) {
      const query = new URLSearchParams({ page: String(page), per_page: '50' });
      if (selector) query.set('label_selector', selector);
      const { status, json } = await this.request('GET', `/servers?${query.toString()}`);
      if (status < 200 || status >= 300) {
        throw new Error(`Hetzner listByLabel failed (HTTP ${status}): ${JSON.stringify(json)}`);
      }
      const body = json as {
        servers?: HetznerServer[];
        meta?: { pagination?: { next_page?: number | null } };
      };
      for (const s of body.servers ?? []) {
        servers.push({ id: s.id, name: s.name, created: s.created, labels: s.labels ?? {} });
      }
      const next = body.meta?.pagination?.next_page;
      if (!next) break;
      page = next;
    }
    return servers;
  }
}
