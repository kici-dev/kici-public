/**
 * Firecracker REST API client over Unix domain sockets.
 *
 * Provides a thin wrapper around Node.js built-in `http` module for communicating
 * with Firecracker's REST API. Uses the `socketPath` option for HTTP-over-Unix-socket.
 *
 * Only used for post-boot operations:
 * - MMDS data injection (passing agent config to the guest VM)
 * - Graceful shutdown via SendCtrlAltDel (x86_64 only)
 * - Socket readiness polling after jailer invocation
 *
 * Pre-boot VM configuration uses `--config-file` JSON (atomic, simpler).
 *
 * @see https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
 * @see https://github.com/firecracker-microvm/firecracker/blob/main/docs/mmds/mmds-user-guide.md
 */

import http from 'node:http';

/**
 * Error thrown when the Firecracker API returns a non-2xx status code
 * or a network-level error occurs.
 */
export class FirecrackerApiError extends Error {
  /** HTTP status code from the Firecracker API (undefined for network errors) */
  readonly statusCode: number | undefined;
  /** The API path that was requested */
  readonly path: string;
  /** The response body from the Firecracker API */
  readonly responseBody: string;

  constructor(message: string, path: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = 'FirecrackerApiError';
    this.path = path;
    this.statusCode = statusCode;
    this.responseBody = responseBody ?? '';
  }
}

/**
 * Thin REST client for the Firecracker API over Unix domain sockets.
 *
 * No external dependencies -- uses Node.js built-in `http` module with
 * the `socketPath` option for HTTP-over-Unix-socket communication.
 */
export class FirecrackerApi {
  constructor(private readonly socketPath: string) {}

  /**
   * Send an HTTP request to the Firecracker API.
   *
   * @param method - HTTP method (GET, PUT, PATCH)
   * @param path - API path (e.g., '/mmds', '/actions', '/')
   * @param body - Optional JSON body for PUT/PATCH requests
   * @returns Response with statusCode and body
   * @throws FirecrackerApiError on non-2xx status or network error
   */
  private request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {};
      let data: string | undefined;

      if (body !== undefined) {
        data = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }

      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk: Buffer | string) => {
            responseBody += chunk;
          });
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0;
            if (statusCode >= 200 && statusCode < 300) {
              resolve({ statusCode, body: responseBody });
            } else {
              reject(
                new FirecrackerApiError(
                  `Firecracker API ${method} ${path}: ${statusCode} ${responseBody}`,
                  path,
                  statusCode,
                  responseBody,
                ),
              );
            }
          });
        },
      );

      req.on('error', (err) => {
        reject(
          new FirecrackerApiError(
            `Firecracker API ${method} ${path}: ${err.message}`,
            path,
            undefined,
            '',
          ),
        );
      });

      if (data !== undefined) {
        req.write(data);
      }
      req.end();
    });
  }

  /**
   * Inject MMDS (Micro VM Metadata Service) data into a running VM.
   *
   * Uses MMDS v2 data injection endpoint. The data should follow the structure:
   * `{ latest: { 'meta-data': { ... } } }`
   *
   * The guest VM reads this data from http://169.254.169.254/latest/meta-data/
   * using a token-based session (MMDS v2).
   *
   * @param data - Metadata object to inject
   * @see https://github.com/firecracker-microvm/firecracker/blob/main/docs/mmds/mmds-user-guide.md
   */
  async putMmds(data: Record<string, unknown>): Promise<void> {
    await this.request('PUT', '/mmds', data);
  }

  /**
   * Clear MMDS data after agent has received config via WS.
   * Replaces the MMDS data with an empty meta-data object.
   * Called after receiving config.ack from the agent.
   */
  async clearMmds(): Promise<void> {
    await this.request('PUT', '/mmds', {
      latest: { 'meta-data': {} },
    });
  }

  /**
   * Send a SendCtrlAltDel action for graceful x86_64 shutdown.
   *
   * This simulates pressing Ctrl+Alt+Del on the virtual keyboard,
   * which triggers a clean shutdown in most Linux distributions.
   *
   * Note: Only works on x86_64. On arm64, the i8042 keyboard controller
   * is not available, so this action is not supported. Use process kill
   * as fallback on arm64.
   *
   * @see https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
   */
  async sendCtrlAltDel(): Promise<void> {
    await this.request('PUT', '/actions', { action_type: 'SendCtrlAltDel' });
  }

  /**
   * Get instance info from the Firecracker API root endpoint.
   *
   * Used to check if the API socket is reachable and the VM is running.
   * Returns the parsed JSON response with instance information.
   */
  async getInstanceInfo(): Promise<Record<string, unknown>> {
    const response = await this.request('GET', '/');
    return JSON.parse(response.body) as Record<string, unknown>;
  }

  /**
   * Poll the Firecracker API socket until it becomes reachable or timeout expires.
   *
   * Used after jailer invocation to wait for Firecracker to create the API socket
   * and become ready to accept requests.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
   * @param intervalMs - Polling interval in milliseconds (default: 100)
   * @returns true if socket became reachable, false on timeout
   */
  async waitForSocket(timeoutMs: number = 5000, intervalMs: number = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        await this.getInstanceInfo();
        return true;
      } catch {
        // Socket not ready yet, wait and retry
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return false;
  }
}
