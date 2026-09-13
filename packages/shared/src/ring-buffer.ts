/**
 * Generic ring buffer with a configurable maximum size.
 *
 * When the buffer reaches its maximum size, adding a new item drops the oldest
 * item (FIFO overflow). This prevents unbounded memory growth for buffered
 * messages or log lines during temporary disconnections.
 */
export class RingBuffer<T> {
  private buffer: T[] = [];
  private readonly maxSize: number;
  private _droppedCount: number = 0;

  constructor(options?: { maxSize?: number }) {
    this.maxSize = options?.maxSize ?? 10_000;
  }

  /**
   * Add an item to the buffer.
   * Returns true if the item was added normally, false if the oldest item
   * was dropped to make room (ring buffer overflow).
   */
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
   * Flush all buffered items in insertion order, clearing the buffer.
   * Does NOT reset droppedCount -- caller must explicitly call resetDroppedCount() after processing.
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
