import { describe, it, expect, beforeEach } from 'vitest';
import { LogBuffer } from './log-buffer.js';

describe('LogBuffer', () => {
  let buffer: LogBuffer;

  beforeEach(() => {
    buffer = new LogBuffer();
  });

  describe('add() and flush()', () => {
    it('stores lines and flush() returns them in insertion order', () => {
      buffer.add('line 1');
      buffer.add('line 2');
      buffer.add('line 3');

      const flushed = buffer.flush();
      expect(flushed).toEqual(['line 1', 'line 2', 'line 3']);
    });

    it('returns true when line is added without overflow', () => {
      expect(buffer.add('hello')).toBe(true);
      expect(buffer.add('world')).toBe(true);
    });

    it('clears buffer after flush', () => {
      buffer.add('line 1');
      buffer.flush();

      expect(buffer.size()).toBe(0);
      expect(buffer.flush()).toEqual([]);
    });

    it('returns empty array when buffer is empty', () => {
      expect(buffer.flush()).toEqual([]);
    });
  });

  describe('ring buffer behavior', () => {
    it('drops oldest line when at capacity', () => {
      const small = new LogBuffer({ maxLines: 3 });

      expect(small.add('first')).toBe(true);
      expect(small.add('second')).toBe(true);
      expect(small.add('third')).toBe(true);

      // Buffer full -- oldest dropped
      expect(small.add('fourth')).toBe(false);
      expect(small.size()).toBe(3);

      const flushed = small.flush();
      expect(flushed).toEqual(['second', 'third', 'fourth']);
    });

    it('drops multiple oldest lines when many overflow', () => {
      const small = new LogBuffer({ maxLines: 2 });

      small.add('a');
      small.add('b');
      small.add('c');
      small.add('d');

      expect(small.size()).toBe(2);
      expect(small.flush()).toEqual(['c', 'd']);
    });
  });

  describe('size()', () => {
    it('reflects current count', () => {
      expect(buffer.size()).toBe(0);
      buffer.add('line 1');
      expect(buffer.size()).toBe(1);
      buffer.add('line 2');
      expect(buffer.size()).toBe(2);
    });

    it('does not exceed maxLines', () => {
      const small = new LogBuffer({ maxLines: 5 });
      for (let i = 0; i < 10; i++) {
        small.add(`line ${i}`);
      }
      expect(small.size()).toBe(5);
    });
  });

  describe('clear()', () => {
    it('empties buffer without returning lines', () => {
      buffer.add('line 1');
      buffer.add('line 2');
      expect(buffer.size()).toBe(2);

      buffer.clear();
      expect(buffer.size()).toBe(0);
      expect(buffer.flush()).toEqual([]);
    });
  });

  describe('defaults', () => {
    it('defaults to 10,000 maxLines', () => {
      const defaultBuffer = new LogBuffer();
      for (let i = 0; i < 10_001; i++) {
        defaultBuffer.add(`line ${i}`);
      }
      expect(defaultBuffer.size()).toBe(10_000);
    });

    it('respects custom maxLines', () => {
      const custom = new LogBuffer({ maxLines: 5 });
      for (let i = 0; i < 10; i++) {
        custom.add(String(i));
      }
      expect(custom.size()).toBe(5);

      const flushed = custom.flush();
      // Should be the last 5 lines (5, 6, 7, 8, 9)
      expect(flushed).toEqual(['5', '6', '7', '8', '9']);
    });
  });

  describe('handles various line content', () => {
    it('handles empty strings', () => {
      buffer.add('');
      expect(buffer.flush()).toEqual(['']);
    });

    it('handles JSON strings', () => {
      const json = JSON.stringify({ level: 'info', message: 'test', timestamp: '2026-01-01' });
      buffer.add(json);
      expect(buffer.flush()).toEqual([json]);
    });

    it('handles multi-line strings as single entries', () => {
      buffer.add('line 1\nline 2');
      expect(buffer.flush()).toEqual(['line 1\nline 2']);
      expect(buffer.size()).toBe(0);
    });
  });
});
