import { describe, expect, it } from 'vitest';
import { jsonResponse } from './http.js';

describe('jsonResponse', () => {
  it('serialises the body with a JSON content type and status 200', async () => {
    const res = jsonResponse({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('takes a status', async () => {
    const res = jsonResponse({ error: 'nope' }, 404);
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('serialises an array body', async () => {
    expect(await jsonResponse([1, 2]).json()).toEqual([1, 2]);
  });
});
