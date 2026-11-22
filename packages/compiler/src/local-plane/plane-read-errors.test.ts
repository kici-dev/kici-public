import { describe, it, expect } from 'vitest';
import { AdminApiHttpError, AdminApiUnreachableError } from '@kici-dev/orchestrator';
import { describePlaneReadError, isTransientPlaneReadError } from './plane-read-errors.js';

const unreachable = () =>
  new AdminApiUnreachableError('cannot reach the orchestrator admin API at http://x', {
    cause: new TypeError('fetch failed', { cause: new Error('ECONNRESET') }),
  });

describe('isTransientPlaneReadError', () => {
  // fails-when: a server-side failure or a dropped connection is treated as final
  it('treats 5xx, 429, 408 and a transport failure as transient', () => {
    for (const status of [500, 502, 503, 504, 429, 408]) {
      expect(isTransientPlaneReadError(new AdminApiHttpError(status, 'x')), String(status)).toBe(
        true,
      );
    }
    expect(isTransientPlaneReadError(unreachable())).toBe(true);
  });

  // breaks-if-wrong: a refusal retrying cannot fix still fails at once
  it('treats a refusal, a malformed request and an unknown error as final', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientPlaneReadError(new AdminApiHttpError(status, 'x')), String(status)).toBe(
        false,
      );
    }
    expect(isTransientPlaneReadError(new Error('the admin API request could not be built'))).toBe(
      false,
    );
    expect(isTransientPlaneReadError('HTTP 500: x')).toBe(false);
  });
});

describe('describePlaneReadError', () => {
  it("names a transport failure's innermost cause, without kici-admin's advice", () => {
    expect(describePlaneReadError(unreachable())).toBe('connection failed: ECONNRESET');
    expect(describePlaneReadError(new AdminApiHttpError(500, 'boom'))).toBe('HTTP 500: boom');
  });

  it('names a passed read deadline', () => {
    const timedOut = new AdminApiUnreachableError('no answer from the orchestrator admin API', {
      cause: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    });
    expect(describePlaneReadError(timedOut)).toBe('no answer before the read deadline');
  });
});
