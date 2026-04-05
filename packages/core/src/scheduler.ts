// The Scheduler controls when and how actors drain their mailboxes.
// Actors delegate scheduling decisions here instead of calling setImmediate directly.
//
// Evolution path:
//   Phase 1: one setImmediate per actor per message (current)
//   Phase 1+: configurable throughput — N messages per tick
//   Phase 2: priority queues, work stealing
//   Phase 4: multi-thread aware routing

import { Drainable } from "./types.js";

export class Scheduler {
    readonly throughput: number;
    readonly tickBudget: number; // ms — soft limit per tick, checked between messages

    #queue: Drainable[] = [];
    #enqueued = new Set<Drainable>();
    #scheduled = false; // true only when a setImmediate is pending

    constructor(throughput = 1, tickBudget = 16) {
        this.throughput = throughput;
        this.tickBudget = tickBudget;
    }

    enqueue(actor: Drainable): void {
        if (this.#enqueued.has(actor)) return;
        this.#queue.push(actor);
        this.#enqueued.add(actor);
        this.#scheduleIfNeeded();
    }

    #scheduleIfNeeded(): void {
        if (!this.#scheduled && this.#queue.length > 0) {
            this.#scheduled = true;
            setImmediate(() => this.#tick());
        }
    }

    async #tick(): Promise<void> {
        this.#scheduled = false; // reset FIRST — enqueues during awaits can now schedule

        const deadline = performance.now() + this.tickBudget;

        while (this.#queue.length > 0) {
            const actor = this.#queue.shift()!;
            this.#enqueued.delete(actor);

            let hasMore = true;
            let count = 0;
            do {
                hasMore = await actor.drain();
                count++;
            } while (hasMore && count < this.throughput && performance.now() < deadline);

            if (hasMore) this.enqueue(actor);
            if (performance.now() >= deadline) break;
        }

        this.#scheduleIfNeeded(); // reschedule if work remains or new actors arrived during awaits
    }

    // Resolves when the queue is empty and no tick is pending.
    // Useful for graceful shutdown and testing.
    whenIdle(): Promise<void> {
        if (!this.#scheduled && this.#queue.length === 0) return Promise.resolve();
        return new Promise(resolve => {
            const check = () => {
                if (!this.#scheduled && this.#queue.length === 0) resolve();
                else setImmediate(check);
            };
            setImmediate(check);
        });
    }
}

// Default scheduler — used when spawn() is called without one.
// All actors in the same process share this unless overridden.
export const DEFAULT_SCHEDULER = new Scheduler(100, 16);