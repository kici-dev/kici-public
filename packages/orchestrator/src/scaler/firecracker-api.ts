/**
 * Firecracker REST API client over a Unix domain socket (`http` with `socketPath`).
 *
 * Post-boot operations only:
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

/** A non-2xx Firecracker API response, or a network-level error. */
export class FirecrackerApiError extends Error {
  /** Undefined for a network error. */
  readonly statusCode: number | undefined;
  readonly path: string;
  readonly responseBody: string;

  constructor(message: string, path: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = 'FirecrackerApiError';
    this.path = path;
    this.statusCode = statusCode;
    this.responseBody = responseBody ?? '';
  }
}

export class FirecrackerApi {
  /**
   * Aborts every in-flight and later request. The spawn path sets it so a spawn
   * deadline stops the provisioning calls against a VM the manager gave up on.
   */
  private signal: AbortSignal | undefined;

  constructor(
    private readonly socketPath: string,
    signal?: AbortSignal,
  ) {
    this.signal = signal;
  }

  /** @throws FirecrackerApiError on a non-2xx status or a network error */
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
          signal: this.signal,
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
   * Inject MMDS (Micro VM Metadata Service) v2 data into a running VM, shaped
   * `{ latest: { 'meta-data': { ... } } }`. The guest reads it from
   * http://169.254.169.254/latest/meta-data/ with a token-based session.
   *
   * @see https://github.com/firecracker-microvm/firecracker/blob/main/docs/mmds/mmds-user-guide.md
   */
  async putMmds(data: Record<string, unknown>): Promise<void> {
    await this.request('PUT', '/mmds', data);
  }

  /**
   * Replace the MMDS data with an empty meta-data object once the agent's
   * config.ack confirms it received its config over WS.
   */
  async clearMmds(): Promise<void> {
    await this.request('PUT', '/mmds', {
      latest: { 'meta-data': {} },
    });
  }

  /**
   * Graceful shutdown: Ctrl+Alt+Del on the virtual keyboard, which most Linux
   * distributions answer with a clean shutdown. x86_64 only: arm64 has no i8042
   * keyboard controller, so kill the process there instead.
   *
   * @see https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
   */
  async sendCtrlAltDel(): Promise<void> {
    await this.request('PUT', '/actions', { action_type: 'SendCtrlAltDel' });
  }

  /**
   * Instance info from the API root, parsed. Doubles as the check that the API
   * socket is reachable and the VM is running.
   */
  async getInstanceInfo(): Promise<Record<string, unknown>> {
    const response = await this.request('GET', '/');
    return JSON.parse(response.body) as Record<string, unknown>;
  }

  /**
   * Poll the API socket after the jailer starts, until Firecracker accepts
   * requests (true) or `timeoutMs` passes (false). Both arguments are in ms.
   */
  async waitForSocket(timeoutMs: number = 5000, intervalMs: number = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && this.signal?.aborted !== true) {
      try {
        await this.getInstanceInfo();
        return true;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return false;
  }
}
