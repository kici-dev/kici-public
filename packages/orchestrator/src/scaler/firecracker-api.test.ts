import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Mock the Node.js http module to simulate Unix domain socket communication.
 * Each test configures the mock response via setupMockResponse().
 */
let mockResponseStatusCode = 200;
let mockResponseBody = '';
let mockRequestError: Error | null = null;
let capturedOptions: Record<string, unknown> | null = null;
let capturedBody: string | null = null;

class MockIncomingMessage extends EventEmitter {
  statusCode: number;
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
}

class MockClientRequest extends EventEmitter {
  writtenData = '';
  ended = false;

  write(data: string): boolean {
    this.writtenData = data;
    return true;
  }

  end(): void {
    this.ended = true;

    if (mockRequestError) {
      // Emit error asynchronously to match real behavior
      queueMicrotask(() => {
        this.emit('error', mockRequestError);
      });
      return;
    }

    // Emit response asynchronously
    queueMicrotask(() => {
      // The response callback was captured by vi.mock
    });
  }
}

let lastMockRequest: MockClientRequest | null = null;

vi.mock('node:http', () => {
  return {
    default: {
      request: (options: Record<string, unknown>, callback: (res: MockIncomingMessage) => void) => {
        capturedOptions = options;
        const req = new MockClientRequest();
        lastMockRequest = req;

        // Simulate async response delivery
        const originalEnd = req.end.bind(req);
        req.end = () => {
          originalEnd();

          if (!mockRequestError) {
            queueMicrotask(() => {
              const res = new MockIncomingMessage(mockResponseStatusCode);
              callback(res);
              // Emit data and end
              if (mockResponseBody) {
                res.emit('data', mockResponseBody);
              }
              res.emit('end');
            });
          }
        };

        return req;
      },
    },
  };
});

function setupMockResponse(statusCode: number, body: string) {
  mockResponseStatusCode = statusCode;
  mockResponseBody = body;
  mockRequestError = null;
}

function setupMockError(error: Error) {
  mockRequestError = error;
}

// Import after mocking
const { FirecrackerApi, FirecrackerApiError } = await import('./firecracker-api.js');

describe('FirecrackerApi', () => {
  beforeEach(() => {
    mockResponseStatusCode = 200;
    mockResponseBody = '';
    mockRequestError = null;
    capturedOptions = null;
    capturedBody = null;
    lastMockRequest = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('putMmds()', () => {
    it('sends PUT to /mmds with correct JSON body', async () => {
      setupMockResponse(204, '');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      const metadata = {
        latest: {
          'meta-data': {
            'kici-orchestrator-url': 'http://localhost:4000',
            'kici-agent-id': 'agent-1',
          },
        },
      };

      await api.putMmds(metadata);

      expect(capturedOptions).toBeTruthy();
      expect(capturedOptions!.socketPath).toBe('/tmp/firecracker.socket');
      expect(capturedOptions!.path).toBe('/mmds');
      expect(capturedOptions!.method).toBe('PUT');
      expect(lastMockRequest!.writtenData).toBe(JSON.stringify(metadata));
    });

    it('sets Content-Type and Content-Length headers', async () => {
      setupMockResponse(204, '');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      const data = { latest: { 'meta-data': { key: 'value' } } };
      await api.putMmds(data);

      const headers = capturedOptions!.headers as Record<string, string | number>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Content-Length']).toBe(Buffer.byteLength(JSON.stringify(data)));
    });
  });

  describe('clearMmds()', () => {
    it('sends PUT to /mmds with empty meta-data object', async () => {
      setupMockResponse(204, '');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      await api.clearMmds();

      expect(capturedOptions).toBeTruthy();
      expect(capturedOptions!.path).toBe('/mmds');
      expect(capturedOptions!.method).toBe('PUT');
      expect(lastMockRequest!.writtenData).toBe(JSON.stringify({ latest: { 'meta-data': {} } }));
    });
  });

  describe('sendCtrlAltDel()', () => {
    it('sends PUT to /actions with correct action_type', async () => {
      setupMockResponse(204, '');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      await api.sendCtrlAltDel();

      expect(capturedOptions!.path).toBe('/actions');
      expect(capturedOptions!.method).toBe('PUT');
      expect(lastMockRequest!.writtenData).toBe(JSON.stringify({ action_type: 'SendCtrlAltDel' }));
    });
  });

  describe('getInstanceInfo()', () => {
    it('sends GET to / and returns parsed JSON response', async () => {
      const instanceInfo = {
        id: 'vm-1',
        state: 'Running',
        vmm_version: '1.0.0',
      };
      setupMockResponse(200, JSON.stringify(instanceInfo));
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      const result = await api.getInstanceInfo();

      expect(capturedOptions!.path).toBe('/');
      expect(capturedOptions!.method).toBe('GET');
      expect(result).toEqual(instanceInfo);
    });

    it('does not send a body for GET requests', async () => {
      setupMockResponse(200, JSON.stringify({ state: 'Running' }));
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      await api.getInstanceInfo();

      // No Content-Type or Content-Length for GET
      const headers = capturedOptions!.headers as Record<string, string | number>;
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers['Content-Length']).toBeUndefined();
      expect(lastMockRequest!.writtenData).toBe('');
    });
  });

  describe('error handling', () => {
    it('throws FirecrackerApiError on non-2xx status with status and body', async () => {
      const errorBody = '{"fault_message":"Invalid request method and target"}';
      setupMockResponse(400, errorBody);
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      try {
        await api.putMmds({ test: true });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FirecrackerApiError);
        const apiErr = err as InstanceType<typeof FirecrackerApiError>;
        expect(apiErr.statusCode).toBe(400);
        expect(apiErr.path).toBe('/mmds');
        expect(apiErr.responseBody).toBe(errorBody);
        expect(apiErr.message).toContain('400');
        expect(apiErr.message).toContain('/mmds');
      }
    });

    it('throws FirecrackerApiError on 500 server error', async () => {
      setupMockResponse(500, 'Internal error');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      await expect(api.sendCtrlAltDel()).rejects.toThrow(FirecrackerApiError);
      await expect(api.sendCtrlAltDel()).rejects.toThrow(/500/);
    });

    it('throws FirecrackerApiError on network error (socket not found)', async () => {
      setupMockError(new Error('connect ENOENT /tmp/nonexistent.socket'));
      const api = new FirecrackerApi('/tmp/nonexistent.socket');

      try {
        await api.getInstanceInfo();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FirecrackerApiError);
        const apiErr = err as InstanceType<typeof FirecrackerApiError>;
        expect(apiErr.statusCode).toBeUndefined();
        expect(apiErr.path).toBe('/');
        expect(apiErr.message).toContain('ENOENT');
      }
    });
  });

  describe('waitForSocket()', () => {
    it('returns true when socket becomes available', async () => {
      vi.useRealTimers();
      setupMockResponse(200, JSON.stringify({ state: 'Running' }));
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      const result = await api.waitForSocket(5000, 100);
      expect(result).toBe(true);
    });

    it('returns false on timeout when socket never becomes available', async () => {
      vi.useRealTimers();
      // Always fail
      setupMockError(new Error('connect ENOENT'));
      const api = new FirecrackerApi('/tmp/nonexistent.socket');

      const result = await api.waitForSocket(200, 50);
      expect(result).toBe(false);
    });

    it('retries until socket becomes available', async () => {
      vi.useRealTimers();
      let callCount = 0;

      // Override the mock to fail first few times, then succeed
      const originalStatusCode = mockResponseStatusCode;
      const origError = mockRequestError;

      // Start with errors
      setupMockError(new Error('connect ENOENT'));

      const api = new FirecrackerApi('/tmp/firecracker.socket');

      // After a short delay, make the socket available
      setTimeout(() => {
        mockRequestError = null;
        mockResponseStatusCode = 200;
        mockResponseBody = JSON.stringify({ state: 'Running' });
      }, 150);

      const result = await api.waitForSocket(1000, 50);
      expect(result).toBe(true);
    });

    it('uses default timeout and interval values', async () => {
      vi.useRealTimers();
      setupMockResponse(200, JSON.stringify({ state: 'Running' }));
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      // Should work with defaults (5000ms timeout, 100ms interval)
      const result = await api.waitForSocket();
      expect(result).toBe(true);
    });
  });

  describe('request headers', () => {
    it('includes correct Content-Type and Content-Length for PUT requests', async () => {
      setupMockResponse(204, '');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      const body = { action_type: 'SendCtrlAltDel' };
      await api.sendCtrlAltDel();

      const headers = capturedOptions!.headers as Record<string, string | number>;
      expect(headers['Content-Type']).toBe('application/json');
      const expectedLength = Buffer.byteLength(JSON.stringify(body));
      expect(headers['Content-Length']).toBe(expectedLength);
    });

    it('handles unicode content length correctly', async () => {
      setupMockResponse(204, '');
      const api = new FirecrackerApi('/tmp/firecracker.socket');

      const unicodeData = { latest: { 'meta-data': { name: 'test-\u00e9\u00e0\u00fc' } } };
      await api.putMmds(unicodeData);

      const headers = capturedOptions!.headers as Record<string, string | number>;
      const jsonStr = JSON.stringify(unicodeData);
      // Buffer.byteLength accounts for multi-byte unicode characters
      expect(headers['Content-Length']).toBe(Buffer.byteLength(jsonStr));
    });
  });

  describe('FirecrackerApiError', () => {
    it('has correct name property', () => {
      const err = new FirecrackerApiError('test', '/path', 400, 'body');
      expect(err.name).toBe('FirecrackerApiError');
    });

    it('stores path, statusCode, and responseBody', () => {
      const err = new FirecrackerApiError('test message', '/mmds', 400, 'error body');
      expect(err.message).toBe('test message');
      expect(err.path).toBe('/mmds');
      expect(err.statusCode).toBe(400);
      expect(err.responseBody).toBe('error body');
    });

    it('defaults responseBody to empty string when not provided', () => {
      const err = new FirecrackerApiError('test', '/path');
      expect(err.responseBody).toBe('');
      expect(err.statusCode).toBeUndefined();
    });

    it('extends Error', () => {
      const err = new FirecrackerApiError('test', '/path');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
