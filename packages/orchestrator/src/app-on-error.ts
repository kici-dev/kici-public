/**
 * The orchestrator's last-resort HTTP error handler.
 *
 * Without one, Hono answers an unhandled throw with a bare, unstructured 500:
 * no JSON body, no route context, and nothing written to our own logs. Every
 * admin router already catches inside its handlers (routes/admin-errors.ts),
 * and the auth path catches inside its middleware (routes/admin-auth.ts) -- this
 * covers whatever neither does.
 *
 * It is a backstop, not a substitute for a specific boundary: a targeted catch
 * can return the right status for its failure (503 when authentication cannot
 * be completed), while a generic net can only say "something broke".
 */
import type { ErrorHandler } from 'hono';
import { createLogger, toErrorMessage } from '@kici-dev/shared';

const defaultLogger = createLogger({ prefix: 'http-error' });

export interface OnErrorOptions {
  /** Which app this handler guards. The orchestrator has exactly two Hono roots. */
  role: 'coordinator' | 'worker';
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Build the `app.onError` handler for one Hono composition root.
 *
 * @param opts - The app role recorded on every log line, and an optional logger.
 * @returns A Hono error handler returning a structured 500.
 */
export function createOnErrorHandler(opts: OnErrorOptions): ErrorHandler {
  const logger = opts.logger ?? defaultLogger;

  return (err, c) => {
    // An HTTPException is a *deliberate* response thrown as control flow, not a
    // fault: Hono's own `bodyLimit` throws one to answer an oversized upload
    // with 413. Pass it through exactly as Hono's default handler does, so
    // registering this backstop cannot silently rewrite a considered 4xx into a
    // 500 -- which would both misattribute the failure and inflate the very 5xx
    // error-rate signal this handler exists to keep honest. Duck-typed rather
    // than `instanceof`, so an exception from a second copy of hono in the
    // dependency graph is still recognized.
    if ('getResponse' in err) {
      const res = err.getResponse();
      return c.newResponse(res.body, res);
    }

    // Method, path, and the error only. Request headers are never serialized:
    // they carry the Authorization credential.
    logger.error('Unhandled request error', {
      role: opts.role,
      method: c.req.method,
      path: c.req.path,
      error: toErrorMessage(err),
      stack: err.stack,
    });
    return c.json({ error: 'Internal server error' }, 500);
  };
}
