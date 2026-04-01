import { jest } from '@jest/globals';
import { Scheduler } from '../src/scheduler.js';
import { Drainable } from '../src/types.js';

// Creates a Drainable with a fixed number of messages.
// Each drain() call consumes one message and returns true if more remain.
function makeDrainable(messages: number): { actor: Drainable; drainCount: () => number } {
    let remaining = messages;
    let drains = 0;
    const actor: Drainable = {
        drain: jest.fn(async () => {
            drains++;
            remaining--;
            return remaining > 0;
        }),
    };
    return { actor, drainCount: () => drains };
}

// Creates a Drainable whose drain() responses are controlled explicitly.
// Useful for testing multi-enqueue scenarios with predictable idle points.
function makeDrainableFromResponses(responses: boolean[]): { actor: Drainable; drainCount: () => number } {
    let i = 0;
    let drains = 0;
    const actor: Drainable = {
        drain: jest.fn(async () => {
            drains++;
            return responses[i++] ?? false;
        }),
    };
    return { actor, drainCount: () => drains };
}

describe('Scheduler', () => {

    // ── enqueue ───────────────────────────────────────────────────────────────

    describe('enqueue', () => {
        it('drains an enqueued actor', async () => {
            const scheduler = new Scheduler(1, 100);
            const { actor, drainCount } = makeDrainable(1);

            scheduler.enqueue(actor);
            await scheduler.whenIdle();

            expect(drainCount()).toBe(1);
        });

        it('does not enqueue the same actor twice before the first tick', async () => {
            const scheduler = new Scheduler(10, 100);
            const { actor, drainCount } = makeDrainable(1);

            // enqueue the same actor 3 times — only 1 should be processed per tick
            scheduler.enqueue(actor);
            scheduler.enqueue(actor);
            scheduler.enqueue(actor);

            await scheduler.whenIdle();

            expect(drainCount()).toBe(1);
        });

        it('processes multiple distinct actors', async () => {
            const scheduler = new Scheduler(1, 100);
            const a = makeDrainable(1);
            const b = makeDrainable(1);

            scheduler.enqueue(a.actor);
            scheduler.enqueue(b.actor);
            await scheduler.whenIdle();

            expect(a.drainCount()).toBe(1);
            expect(b.drainCount()).toBe(1);
        });
    });

    // ── throughput ────────────────────────────────────────────────────────────

    describe('throughput', () => {
        it('drains up to throughput messages per actor per tick', async () => {
            // tickBudget=1000 so deadline doesn't interfere
            const scheduler = new Scheduler(3, 1000);
            const { actor, drainCount } = makeDrainable(3);

            scheduler.enqueue(actor);
            await scheduler.whenIdle();

            expect(drainCount()).toBe(3);
        });

        it('re-enqueues actor and drains all messages across multiple ticks', async () => {
            const scheduler = new Scheduler(2, 1000);
            const { actor, drainCount } = makeDrainable(5);

            scheduler.enqueue(actor);
            await scheduler.whenIdle();

            expect(drainCount()).toBe(5);
        });

        it('all actors get a turn within one tick when throughput covers their messages', async () => {
            // throughput=3, tickBudget=1000 — each actor has 2 messages, well within budget
            // both actors should fully drain in a single tick without re-scheduling
            const scheduler = new Scheduler(3, 1000);
            const ticksFired: string[] = [];

            const makeTracked = (name: string, msgs: number): Drainable => {
                let remaining = msgs;
                return {
                    drain: async () => {
                        ticksFired.push(name);
                        remaining--;
                        return remaining > 0;
                    },
                };
            };

            const a = makeTracked('A', 2);
            const b = makeTracked('B', 2);

            scheduler.enqueue(a);
            scheduler.enqueue(b);
            await scheduler.whenIdle();

            // A drains 2, B drains 2 — all within one tick
            expect(ticksFired).toEqual(['A', 'A', 'B', 'B']);
        });

        it('actors with more messages than throughput are re-enqueued at the back', async () => {
            // throughput=2, each actor has 4 messages
            // tick 1: A drains 2, B drains 2 → both re-enqueued
            // tick 2: A drains 2, B drains 2 → done
            const scheduler = new Scheduler(2, 1000);
            const order: string[] = [];

            const makeTracked = (name: string, msgs: number): Drainable => {
                let remaining = msgs;
                return {
                    drain: async () => {
                        order.push(name);
                        remaining--;
                        return remaining > 0;
                    },
                };
            };

            const a = makeTracked('A', 4);
            const b = makeTracked('B', 4);

            scheduler.enqueue(a);
            scheduler.enqueue(b);
            await scheduler.whenIdle();

            expect(order).toEqual(['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B']);
        });
    });

    // ── fairness ──────────────────────────────────────────────────────────────

    describe('fairness', () => {
        it('round-robins between multiple actors with throughput=1', async () => {
            const order: string[] = [];
            const scheduler = new Scheduler(1, 1000);

            const makeOrdered = (name: string, msgs: number): Drainable => {
                let remaining = msgs;
                return {
                    drain: jest.fn(async () => {
                        order.push(name);
                        remaining--;
                        return remaining > 0;
                    }),
                };
            };

            const a = makeOrdered('A', 2);
            const b = makeOrdered('B', 2);

            scheduler.enqueue(a);
            scheduler.enqueue(b);
            await scheduler.whenIdle();

            // A and B should alternate — not AAABBB
            expect(order).toEqual(['A', 'B', 'A', 'B']);
        });
    });

    // ── tickBudget ────────────────────────────────────────────────────────────

    describe('tickBudget', () => {
        it('eventually drains all messages even with a tight budget', async () => {
            const scheduler = new Scheduler(1, 1); // budget=1ms forces frequent reschedules
            const { actor, drainCount } = makeDrainable(5);

            scheduler.enqueue(actor);
            await scheduler.whenIdle();

            expect(drainCount()).toBe(5);
        });
    });

    // ── idle ──────────────────────────────────────────────────────────────────

    describe('idle', () => {
        it('whenIdle resolves immediately if nothing is enqueued', async () => {
            const scheduler = new Scheduler();
            await expect(scheduler.whenIdle()).resolves.toBeUndefined();
        });

        it('restarts after going idle when new messages arrive', async () => {
            const scheduler = new Scheduler(1, 100);
            // false = no more messages after this drain → scheduler goes idle
            const { actor, drainCount } = makeDrainableFromResponses([false, false]);

            scheduler.enqueue(actor);
            await scheduler.whenIdle();
            expect(drainCount()).toBe(1);

            // new message arrives — enqueue again after idle
            scheduler.enqueue(actor);
            await scheduler.whenIdle();
            expect(drainCount()).toBe(2);
        });
    });

});
