// =============================================================================
// Fleet Commander — CircularBuffer Unit Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { CircularBuffer } from '../../../src/server/utils/circular-buffer.js';

describe('CircularBuffer', () => {
  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  it('throws when capacity is 0', () => {
    expect(() => new CircularBuffer(0)).toThrow('capacity must be >= 1');
  });

  it('throws when capacity is negative', () => {
    expect(() => new CircularBuffer(-5)).toThrow('capacity must be >= 1');
  });

  it('starts empty', () => {
    const buf = new CircularBuffer<string>(10);
    expect(buf.length).toBe(0);
    expect(buf.capacity).toBe(10);
    expect(buf.toArray()).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // push + toArray (below capacity)
  // ---------------------------------------------------------------------------

  it('stores items below capacity', () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it('stores items at exact capacity', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(10);
    buf.push(20);
    buf.push(30);
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([10, 20, 30]);
  });

  // ---------------------------------------------------------------------------
  // push + toArray (wrapping / overwrite)
  // ---------------------------------------------------------------------------

  it('overwrites oldest when exceeding capacity', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrites 1
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([2, 3, 4]);
  });

  it('wraps around multiple times correctly', () => {
    const buf = new CircularBuffer<number>(3);
    for (let i = 1; i <= 10; i++) {
      buf.push(i);
    }
    // Should contain the last 3: [8, 9, 10]
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([8, 9, 10]);
  });

  it('capacity of 1 always keeps the newest item', () => {
    const buf = new CircularBuffer<string>(1);
    buf.push('a');
    expect(buf.toArray()).toEqual(['a']);
    buf.push('b');
    expect(buf.toArray()).toEqual(['b']);
    buf.push('c');
    expect(buf.length).toBe(1);
    expect(buf.toArray()).toEqual(['c']);
  });

  // ---------------------------------------------------------------------------
  // last()
  // ---------------------------------------------------------------------------

  it('last(0) returns empty array', () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.last(0)).toEqual([]);
  });

  it('last(n) returns last n items in order', () => {
    const buf = new CircularBuffer<number>(10);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    expect(buf.last(3)).toEqual([3, 4, 5]);
    expect(buf.last(1)).toEqual([5]);
  });

  it('last(n) where n >= length returns all items', () => {
    const buf = new CircularBuffer<number>(10);
    buf.push(1);
    buf.push(2);
    expect(buf.last(5)).toEqual([1, 2]);
    expect(buf.last(2)).toEqual([1, 2]);
  });

  it('last() works correctly after wrapping', () => {
    const buf = new CircularBuffer<number>(3);
    for (let i = 1; i <= 7; i++) {
      buf.push(i);
    }
    // Buffer contains [5, 6, 7]
    expect(buf.last(2)).toEqual([6, 7]);
    expect(buf.last(3)).toEqual([5, 6, 7]);
    expect(buf.last(1)).toEqual([7]);
  });

  it('last() on empty buffer returns empty', () => {
    const buf = new CircularBuffer<number>(5);
    expect(buf.last(3)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // clear()
  // ---------------------------------------------------------------------------

  it('clear resets the buffer', () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    expect(buf.capacity).toBe(5);
  });

  it('push works correctly after clear', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.clear();
    buf.push(10);
    buf.push(20);
    expect(buf.length).toBe(2);
    expect(buf.toArray()).toEqual([10, 20]);
  });

  // ---------------------------------------------------------------------------
  // static from()
  // ---------------------------------------------------------------------------

  it('from() creates a buffer pre-filled with items', () => {
    const buf = CircularBuffer.from([1, 2, 3], 5);
    expect(buf.length).toBe(3);
    expect(buf.capacity).toBe(5);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it('from() with more items than capacity keeps the last N', () => {
    const buf = CircularBuffer.from([1, 2, 3, 4, 5], 3);
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  it('from() with empty array creates empty buffer', () => {
    const buf = CircularBuffer.from<number>([], 5);
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('from() with exactly capacity items fills the buffer', () => {
    const buf = CircularBuffer.from(['a', 'b', 'c'], 3);
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual(['a', 'b', 'c']);
  });

  // ---------------------------------------------------------------------------
  // toArray returns a new copy
  // ---------------------------------------------------------------------------

  it('toArray returns a fresh array each time', () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    const a = buf.toArray();
    const b = buf.toArray();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  // ---------------------------------------------------------------------------
  // Generic type support
  // ---------------------------------------------------------------------------

  it('works with object types', () => {
    interface Item { id: number; name: string }
    const buf = new CircularBuffer<Item>(2);
    buf.push({ id: 1, name: 'alpha' });
    buf.push({ id: 2, name: 'beta' });
    buf.push({ id: 3, name: 'gamma' });
    expect(buf.toArray()).toEqual([
      { id: 2, name: 'beta' },
      { id: 3, name: 'gamma' },
    ]);
  });
});
