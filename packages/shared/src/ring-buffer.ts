/**
 * Bounded FIFO buffer: at its maximum size, adding an item drops the oldest,
 * so messages or log lines buffered during a disconnection cannot grow memory
 * without bound.
 */
export class RingBuffer<T> {
  private buffer: T[] = [];
  private readonly maxSize: number;
  private _droppedCount: number = 0;

  constructor(options?: { maxSize?: number }) {
    this.maxSize = options?.maxSize ?? 10_000;
  }

  /** Add an item. Returns false when the oldest item was dropped to make room. */
  add(item: T): boolean {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
      this.buffer.push(item);
      this._droppedCount++;
      return false;
    }
    this.buffer.push(item);
    return true;
  }

  /**
   * Flush all buffered items in insertion order, clearing the buffer. Does NOT
   * reset droppedCount: the caller calls resetDroppedCount() after processing.
   */
  flush(): T[] {
    const items = this.buffer;
    this.buffer = [];
    return items;
  }

  /** Current number of buffered items. */
  size(): number {
    return this.buffer.length;
  }

  /** Number of items dropped due to overflow since last reset. */
  get droppedCount(): number {
    return this._droppedCount;
  }

  /** Reset the dropped count to 0. Call after processing overflow metrics. */
  resetDroppedCount(): void {
    this._droppedCount = 0;
  }

  /** Clear all buffered items without returning them. Also resets droppedCount. */
  clear(): void {
    this.buffer = [];
    this._droppedCount = 0;
  }
}
