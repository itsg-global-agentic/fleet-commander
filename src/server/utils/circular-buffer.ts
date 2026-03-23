// =============================================================================
// Fleet Commander — CircularBuffer<T>
// =============================================================================
// A fixed-capacity ring buffer with O(1) push and ordered iteration.
// Used by TeamManager to store the last N output lines per team without
// the O(n) cost of Array.shift() on every line.
// =============================================================================

export class CircularBuffer<T> {
  private readonly _buf: (T | undefined)[];
  private readonly _capacity: number;
  private _head: number = 0;   // next write position
  private _count: number = 0;  // current number of items

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error('CircularBuffer capacity must be >= 1');
    }
    this._capacity = capacity;
    this._buf = new Array<T | undefined>(capacity);
  }

  /** Current number of items in the buffer. */
  get length(): number {
    return this._count;
  }

  /** Maximum number of items the buffer can hold. */
  get capacity(): number {
    return this._capacity;
  }

  /** Push an item. When full, the oldest item is silently overwritten. O(1). */
  push(item: T): void {
    this._buf[this._head] = item;
    this._head = (this._head + 1) % this._capacity;
    if (this._count < this._capacity) {
      this._count++;
    }
  }

  /** Return all items in insertion order (oldest first). */
  toArray(): T[] {
    if (this._count === 0) return [];

    const result: T[] = new Array(this._count);
    // Start of the oldest item
    const start = this._count < this._capacity
      ? 0
      : this._head; // when full, head points to oldest

    for (let i = 0; i < this._count; i++) {
      result[i] = this._buf[(start + i) % this._capacity] as T;
    }
    return result;
  }

  /**
   * Return the last `n` items in insertion order (oldest of the n first).
   * If n >= length, returns all items.
   */
  last(n: number): T[] {
    if (n <= 0) return [];
    if (n >= this._count) return this.toArray();

    const result: T[] = new Array(n);
    // _head points to the next write slot, so the newest item is at _head - 1.
    // We want the last n items: indices [_head - n .. _head - 1] mod capacity.
    const startIdx = (this._head - n + this._capacity) % this._capacity;
    for (let i = 0; i < n; i++) {
      result[i] = this._buf[(startIdx + i) % this._capacity] as T;
    }
    return result;
  }

  /** Reset the buffer to empty. */
  clear(): void {
    this._head = 0;
    this._count = 0;
    // Clear references for GC
    this._buf.fill(undefined);
  }

  /**
   * Convenience factory: create a CircularBuffer pre-filled with items.
   * If items.length > capacity, only the last `capacity` items are kept.
   */
  static from<T>(items: T[], capacity: number): CircularBuffer<T> {
    const buf = new CircularBuffer<T>(capacity);
    for (const item of items) {
      buf.push(item);
    }
    return buf;
  }
}
