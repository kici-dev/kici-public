import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  renderManifestFormHtml,
  renderCodeDisplayHtml,
} from '../providers/github/manifest-form.js';

/**
 * Ephemeral localhost server that backs the GitHub App manifest setup flow.
 * Serves the auto-submitting manifest form at `/` and catches GitHub's redirect
 * (`/cb?code=…&state=…`). The setup code is exchanged for credentials in the
 * CLI, never on the Platform — this loopback keeps the whole flow on the
 * orchestrator host (mirrors the `kici login` browser-OAuth loopback).
 */
export interface ManifestLoopback {
  /** http://127.0.0.1:<port>/cb — GitHub redirect target. */
  redirectUrl: string;
  /** http://127.0.0.1:<port>/ — serves the manifest form. */
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
    // The callback result is delivered via a deferred. Settling it stores the
    // outcome; `waitForCode` reads from the stored outcome (or waits for it),
    // so the deferred never sits rejected without a handler attached — which
    // would surface as an unhandled rejection if the callback fires before any
    // `waitForCode` consumer awaits it.
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

    // Swallow client-side socket errors (e.g. a connection torn down right as
    // the server closes) so they never surface as an unhandled exception.
    server.on('clientError', () => {});

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      resolveServer({
        redirectUrl: `${base}/cb`,
        formUrl: `${base}/`,
        waitForCode: (timeoutMs) =>
          new Promise<{ code: string; state: string }>((resolve, reject) => {
            // Already settled before this consumer awaited — replay immediately.
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
