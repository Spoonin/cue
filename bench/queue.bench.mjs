/**
 * Queue implementation benchmark
 *
 * Compares four implementations across five scenarios that reflect
 * real high-load patterns (actor mailboxes, task queues, event buses).
 *
 * Run:  pnpm bench   (from the bench/ directory)
 *       node --expose-gc queue.bench.mjs
 */

import { bench, group, run, summary } from 'mitata';
import Denque from 'denque';
import { Queue } from '@cue/core';

/**
 * Doubly-linked list: true O(1) for every operation, zero memory waste.
 * Higher per-op cost due to object allocation.
 */
class LinkedQueue {
  #head = null;
  #tail = null;
  #size = 0;

  enqueue(item) {
    const node = { value: item, next: null };
    if (this.#tail) this.#tail.next = node;
    else this.#head = node;
    this.#tail = node;
    this.#size++;
  }

  dequeue() {
    if (!this.#head) return undefined;
    const value = this.#head.value;
    this.#head = this.#head.next;
    if (!this.#head) this.#tail = null;
    this.#size--;
    return value;
  }

  peek()    { return this.#head?.value; }
  isEmpty() { return this.#size === 0; }
  size()    { return this.#size; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Thin wrapper to align Denque's API (push/shift/peekFront)
 * with the enqueue/dequeue/peek interface used in this benchmark.
 */
class DenqueQueue {
  #q = new Denque();
  enqueue(item) { this.#q.push(item); }
  dequeue()     { return this.#q.shift(); }
  peek()        { return this.#q.peekFront(); }
  isEmpty()     { return this.#q.isEmpty(); }
  size()        { return this.#q.size(); }
}

const IMPLS = [
  ['linked-list   ', LinkedQueue],
  ['circular-buf  ', Queue],
  ['denque        ', DenqueQueue],
];

function fill(q, n) {
  for (let i = 0; i < n; i++) q.enqueue(i);
}

function drain(q) {
  while (!q.isEmpty()) q.dequeue();
}

function gc() {
  if (typeof global.gc === 'function') global.gc();
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

/**
 * Scenario 1 — Bulk load then full drain
 * Simulates: batch ingestion (log pipeline, snapshot restore).
 * N items enqueued before any dequeue begins.
 */
group('bulk: enqueue 50k → dequeue all', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      bench(label, () => {
        const q = new Impl();
        fill(q, 50_000);
        drain(q);
      });
    }
  });
});

/**
 * Scenario 2 — Steady-state: one enqueue per dequeue
 * Simulates: balanced producer/consumer (actor message loop).
 */
group('steady: 100k × (enqueue + dequeue)', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      const q = new Impl();
      bench(label, () => {
        for (let i = 0; i < 100_000; i++) {
          q.enqueue(i);
          q.dequeue();
        }
      });
    }
  });
});

/**
 * Scenario 3 — Bursty producer
 * Simulates: traffic spikes (HTTP request storms, event fan-out).
 * Alternates between bursts of 1 000 enqueues and 500 dequeues.
 * shift-array is excluded: O(n) shift makes it pathologically slow here.
 */
group('bursty: fill 1k / drain 500 × 200 rounds  [no shift]', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      if (label.includes('shift')) continue;
      bench(label, () => {
        const q = new Impl();
        for (let round = 0; round < 200; round++) {
          for (let i = 0; i < 1_000; i++) q.enqueue(i);
          for (let i = 0; i < 500;   i++) q.dequeue();
        }
        drain(q);
      });
    }
  });
});

/**
 * Scenario 3b — Bursty (small scale, all impls)
 * Same pattern at 10× smaller scale so shift-array can participate.
 */
group('bursty-small: fill 100 / drain 50 × 200 rounds  [all]', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      bench(label, () => {
        const q = new Impl();
        for (let round = 0; round < 200; round++) {
          for (let i = 0; i < 100; i++) q.enqueue(i);
          for (let i = 0; i < 50;  i++) q.dequeue();
        }
        drain(q);
      });
    }
  });
});

/**
 * Scenario 4 — Long-lived large queue (high-watermark pressure)
 * Simulates: slow consumer, queue grows to 5k, then is slowly drained.
 *
 */
group('high-watermark: fill 5k → drain in 500 chunks  [linked + circular]', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      bench(label, () => {
        gc();
        const q = new Impl();
        fill(q, 5_000);
        while (!q.isEmpty()) {
          for (let i = 0; i < 500 && !q.isEmpty(); i++) q.dequeue();
          // only refill while items remain — prevents infinite loop when
          // the queue empties mid-drain-chunk
          if (!q.isEmpty()) for (let i = 0; i < 100; i++) q.enqueue(i);
        }
      });
    }
  });
});

/**
 * Scenario 5 — Shrink / compaction stress (head-pointer specific)
 * Simulates: long-running process that crosses SHRINK_THRESHOLD then refills.
 * Measures whether compaction disrupts subsequent throughput.
 */
group('shrink stress: 12k fill → 11k drain → 5k fill → drain', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      bench(label, () => {
        const q = new Impl();
        fill(q, 12_000);
        for (let i = 0; i < 11_000; i++) q.dequeue(); // crosses threshold
        fill(q, 5_000);
        drain(q);
      });
    }
  });
});

/**
 * Scenario 6 — Peek-heavy read path
 * Simulates: priority inspection, health-check polling, scheduler lookahead.
 * Queue stays full; only peek is called.
 */
group('peek-heavy: 10k items, 100k peeks', () => {
  summary(() => {
    for (const [label, Impl] of IMPLS) {
      const q = new Impl();
      fill(q, 10_000);
      bench(label, () => {
        for (let i = 0; i < 100_000; i++) q.peek();
      });
    }
  });
});

// ─── Run ─────────────────────────────────────────────────────────────────────

await run({ format: 'mitata', colors: true });
