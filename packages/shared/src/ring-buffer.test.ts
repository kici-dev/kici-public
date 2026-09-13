import { describe, it, expect, beforeEach } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  let buffer: RingBuffer<string>;

  beforeEach(() => {
    buffer = new RingBuffer<string>();
  });

  describe('add()', () => {
    it('adds items and returns true', () => {
      expect(buffer.add('a')).toBe(true);
      expect(buffer.add('b')).toBe(true);
      expect(buffer.size()).toBe(2);
    });

    it('returns false when buffer is full and oldest is dropped', () => {
      const small = new RingBuffer<string>({ maxSize: 3 });

      expect(small.add('1')).toBe(true);
      expect(small.add('2')).toBe(true);
      expect(small.add('3')).toBe(true);

      // Buffer full -- oldest dropped
      expect(small.add('4')).toBe(false);
      expect(small.size()).toBe(3);

      const flushed = small.flush();
      expect(flushed).toEqual(['2', '3', '4']);
    });
  });

  describe('flush()', () => {
    it('returns all items in insertion order and clears the buffer', () => {
      buffer.add('x');
      buffer.add('y');
      buffer.add('z');

      const flushed = buffer.flush();
      expect(flushed).toEqual(['x', 'y', 'z']);
      expect(buffer.size()).toBe(0);
      expect(buffer.flush()).toEqual([]);
    });

    it('returns empty array when buffer is empty', () => {
      expect(buffer.flush()).toEqual([]);
    });
  });

  describe('size()', () => {
    it('reflects current count', () => {
      expect(buffer.size()).toBe(0);
      buffer.add('a');
      expect(buffer.size()).toBe(1);
      buffer.add('b');
      expect(buffer.size()).toBe(2);
    });
  });

  describe('clear()', () => {
    it('empties the buffer without returning items', () => {
      buffer.add('a');
      buffer.add('b');
      expect(buffer.size()).toBe(2);

      buffer.clear();
      expect(buffer.size()).toBe(0);
      expect(buffer.flush()).toEqual([]);
    });
  });

  describe('max size', () => {
    it('defaults to 10,000', () => {
      const defaultBuffer = new RingBuffer<number>();
      for (let i = 0; i < 10_001; i++) {
        defaultBuffer.add(i);
      }
      expect(defaultBuffer.size()).toBe(10_000);
    });

    it('respects custom maxSize', () => {
      const custom = new RingBuffer<number>({ maxSize: 5 });
      for (let i = 0; i < 10; i++) {
        custom.add(i);
      }
      expect(custom.size()).toBe(5);

      const flushed = custom.flush();
      expect(flushed).toEqual([5, 6, 7, 8, 9]);
    });

    it('drops multiple oldest items on continued overflow', () => {
      const small = new RingBuffer<string>({ maxSize: 2 });

      small.add('a');
      small.add('b');
      small.add('c');
      small.add('d');

      expect(small.size()).toBe(2);
      expect(small.flush()).toEqual(['c', 'd']);
    });
  });

  describe('droppedCount', () => {
    it('is 0 initially', () => {
      expect(buffer.droppedCount).toBe(0);
    });

    it('remains 0 after adding items within capacity', () => {
      const small = new RingBuffer<string>({ maxSize: 3 });
      small.add('a');
      small.add('b');
      small.add('c');
      expect(small.droppedCount).toBe(0);
    });

    it('equals the number of overflow additions', () => {
      const small = new RingBuffer<string>({ maxSize: 3 });
      small.add('a');
      small.add('b');
      small.add('c');
      small.add('d'); // overflow 1
      small.add('e'); // overflow 2
      expect(small.droppedCount).toBe(2);
    });

    it('resetDroppedCount() resets to 0', () => {
      const small = new RingBuffer<string>({ maxSize: 2 });
      small.add('a');
      small.add('b');
      small.add('c'); // overflow
      expect(small.droppedCount).toBe(1);
      small.resetDroppedCount();
      expect(small.droppedCount).toBe(0);
    });

    it('clear() resets droppedCount to 0', () => {
      const small = new RingBuffer<string>({ maxSize: 2 });
      small.add('a');
      small.add('b');
      small.add('c'); // overflow
      expect(small.droppedCount).toBe(1);
      small.clear();
      expect(small.droppedCount).toBe(0);
    });

    it('flush() does NOT reset droppedCount', () => {
      const small = new RingBuffer<string>({ maxSize: 2 });
      small.add('a');
      small.add('b');
      small.add('c'); // overflow
      expect(small.droppedCount).toBe(1);
      small.flush();
      expect(small.droppedCount).toBe(1);
    });

    it('full lifecycle: add 5 items to maxSize=3 -> droppedCount 2, flush -> still 2, reset -> 0', () => {
      const small = new RingBuffer<string>({ maxSize: 3 });
      small.add('a');
      small.add('b');
      small.add('c');
      small.add('d'); // overflow 1
      small.add('e'); // overflow 2
      expect(small.droppedCount).toBe(2);

      const flushed = small.flush();
      expect(flushed).toEqual(['c', 'd', 'e']);
      expect(small.size()).toBe(0);
      expect(small.droppedCount).toBe(2); // flush does NOT reset

      small.resetDroppedCount();
      expect(small.droppedCount).toBe(0);
    });
  });

  describe('works with object types', () => {
    it('buffers and flushes objects', () => {
      const objBuffer = new RingBuffer<{ id: number; name: string }>();

      const item1 = { id: 1, name: 'first' };
      const item2 = { id: 2, name: 'second' };

      objBuffer.add(item1);
      objBuffer.add(item2);

      const flushed = objBuffer.flush();
      expect(flushed).toEqual([item1, item2]);
    });

    it('handles ring buffer overflow with objects', () => {
      const objBuffer = new RingBuffer<{ value: number }>({ maxSize: 2 });

      objBuffer.add({ value: 1 });
      objBuffer.add({ value: 2 });
      objBuffer.add({ value: 3 });

      expect(objBuffer.size()).toBe(2);
      const flushed = objBuffer.flush();
      expect(flushed).toEqual([{ value: 2 }, { value: 3 }]);
    });
  });
});
