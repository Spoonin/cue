import { Queue } from '../src/queue.js';

describe('Queue', () => {
  let q: Queue<number>;

  beforeEach(() => {
    q = new Queue<number>();
  });

  // ── isEmpty ───────────────────────────────────────────────────────────────

  describe('isEmpty', () => {
    it('is empty on construction', () => {
      expect(q.isEmpty()).toBe(true);
    });

    it('is not empty after an enqueue', () => {
      q.enqueue(1);
      expect(q.isEmpty()).toBe(false);
    });

    it('is empty again after dequeueing the last item', () => {
      q.enqueue(1);
      q.dequeue();
      expect(q.isEmpty()).toBe(true);
    });
  });

  // ── peek ──────────────────────────────────────────────────────────────────

  describe('peek', () => {
    it('returns undefined when empty', () => {
      expect(q.peek()).toBeUndefined();
    });

    it('returns the first-enqueued item without removing it', () => {
      q.enqueue(1);
      q.enqueue(2);
      expect(q.peek()).toBe(1);        // FIFO: front = first in
      expect(q.isEmpty()).toBe(false); // peek must not remove the item
    });
  });

  // ── dequeue ───────────────────────────────────────────────────────────────

  describe('dequeue', () => {
    it('returns undefined when empty', () => {
      expect(q.dequeue()).toBeUndefined();
    });

    it('removes and returns the single item', () => {
      q.enqueue(42);
      expect(q.dequeue()).toBe(42);
      expect(q.isEmpty()).toBe(true);
    });
  });

  // ── FIFO ordering ─────────────────────────────────────────────────────────

  describe('FIFO ordering', () => {
    it('dequeues items in the order they were enqueued', () => {
      q.enqueue(1);
      q.enqueue(2);
      q.enqueue(3);

      expect(q.dequeue()).toBe(1); // first in → first out
      expect(q.dequeue()).toBe(2);
      expect(q.dequeue()).toBe(3);
      expect(q.isEmpty()).toBe(true);
    });

    it('interleaves enqueue and dequeue correctly', () => {
      q.enqueue(10);
      q.enqueue(20);
      expect(q.dequeue()).toBe(10);

      q.enqueue(30);
      expect(q.dequeue()).toBe(20);
      expect(q.dequeue()).toBe(30);
      expect(q.isEmpty()).toBe(true);
    });
  });

  // ── size ─────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('is 0 when empty', () => {
      expect(q.size()).toBe(0);
    });

    it('increases with each enqueue', () => {
      q.enqueue(1);
      expect(q.size()).toBe(1);
      q.enqueue(2);
      expect(q.size()).toBe(2);
      q.enqueue(3);
      expect(q.size()).toBe(3);
    });

    it('decreases with each dequeue', () => {
      q.enqueue(1);
      q.enqueue(2);
      q.dequeue();
      expect(q.size()).toBe(1);
      q.dequeue();
      expect(q.size()).toBe(0);
    });
  });

  // ── shrink threshold ──────────────────────────────────────────────────────

  describe('shrink threshold', () => {
    it('compacts the internal array after heavy use', () => {
      const OVER_THRESHOLD = 10001;
      for (let i = 0; i < OVER_THRESHOLD; i++) q.enqueue(i);
      // drain past the halfway point to trigger the shrink branch
      for (let i = 0; i < Math.ceil(OVER_THRESHOLD / 2) + 1; i++) q.dequeue();
      // queue must still report the correct size and return remaining items
      const remaining = q.size();
      expect(remaining).toBeGreaterThan(0);
      let prev = q.dequeue();
      while (!q.isEmpty()) {
        const next = q.dequeue();
        // items should come out in FIFO order (ascending)
        expect(next).toBeGreaterThan(prev as number);
        prev = next;
      }
    });
  });

  // ── generic typing ────────────────────────────────────────────────────────

  describe('generic typing', () => {
    it('works with strings', () => {
      const sq = new Queue<string>();
      sq.enqueue('hello');
      sq.enqueue('world');
      expect(sq.dequeue()).toBe('hello');
      expect(sq.dequeue()).toBe('world');
    });

    it('works with objects', () => {
      const oq = new Queue<{ id: number }>();
      const a = { id: 1 };
      const b = { id: 2 };
      oq.enqueue(a);
      oq.enqueue(b);
      expect(oq.dequeue()).toBe(a);
      expect(oq.dequeue()).toBe(b);
    });
  });
});
