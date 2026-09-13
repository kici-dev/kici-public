import { vi } from 'vitest';
import type { WsLike } from '../agent/registry.js';
import type { ObserverWsLike } from '../ws/observer-registry.js';

/**
 * Create a mock WsLike with vi.fn() spies on send/close.
 * Used across agent registry, dispatcher, heartbeat, and WS handler tests.
 */
export function mockWs(): WsLike {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}

/**
 * Create a mock ObserverWsLike with vi.fn() spies on send/close.
 * Used by observer-registry tests.
 */
export function mockObserverWs(): ObserverWsLike {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}
