import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  renderManifestFormHtml,
  renderCodeDisplayHtml,
} from '../providers/github/manifest-form.js';

/**
 * Ephemeral localhost server for the GitHub App manifest flow: serves the
 * auto-submitting form at `/` and catches GitHub's `/cb?code=…&state=…`
 * redirect. The setup code is exchanged in the CLI, never on the Platform, so
 * the whole flow stays on the orchestrator host (like `kici login`'s loopback).
 */
export interface ManifestLoopback {
  /** http://127.0.0.1:<port>/cb */
  redirectUrl: string;
  /** http://127.0.0.1:<port>/ */
  formUrl: string;
  waitForCode(timeoutMs: number): Promise<{ code: string; state: string }>;
  close(): void;
}

export function startManifestLoopback(opts: {
  state: string;
  manifestJson: string;
  createUrl: string;
}): Promise<ManifestLoopback> {
  return new Promise((resolveServer) => {
    // Settling stores the outcome and `waitForCode` reads it, so a callback
    // that fires before any consumer awaits never becomes an unhandled rejection.
    let outcome:
      | { ok: true; value: { code: string; state: string } }
      | { ok: false; error: Error }
      | undefined;
    const waiters: Array<{
      resolve: (v: { code: string; state: string }) => void;
      reject: (e: Error) => void;
    }> = [];
    const resolveCode = (value: { code: string; state: string }): void => {
      if (outcome) return;
      outcome = { ok: true, value };
      for (const w of waiters) w.resolve(value);
    };
    const rejectCode = (error: Error): void => {
      if (outcome) return;
      outcome = { ok: false, error };
      for (const w of waiters) w.reject(error);
    };

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/cb') {
        const code = url.searchParams.get('code') ?? '';
        const state = url.searchParams.get('state') ?? '';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(renderCodeDisplayHtml(code));
        if (state !== opts.state) {
          rejectCode(new Error('OAuth state mismatch — aborting'));
        } else {
          resolveCode({ code, state });
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        renderManifestFormHtml({
          createUrl: opts.createUrl,
          state: opts.state,
          manifestJson: opts.manifestJson,
        }),
      );
    });

    // A client socket torn down as the server closes must not become an unhandled exception.
    server.on('clientError', () => {});

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      resolveServer({
        redirectUrl: `${base}/cb`,
        formUrl: `${base}/`,
        waitForCode: (timeoutMs) =>
          new Promise<{ code: string; state: string }>((resolve, reject) => {
            // Settled before this consumer awaited: replay.
            if (outcome) {
              outcome.ok ? resolve(outcome.value) : reject(outcome.error);
              return;
            }
            const timer = setTimeout(
              () => reject(new Error('Timed out waiting for GitHub callback')),
              timeoutMs,
            );
            waiters.push({
              resolve: (v) => {
                clearTimeout(timer);
                resolve(v);
              },
              reject: (e) => {
                clearTimeout(timer);
                reject(e);
              },
            });
          }),
        close: () => server.close(),
      });
    });
  });
}
