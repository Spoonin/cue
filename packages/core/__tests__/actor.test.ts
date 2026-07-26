import { describe, expect, it } from '@jest/globals';
import { Actor, spawn } from "../src/actor";
import { Scheduler } from "../src/scheduler";
import { Supervisor } from "../src/supervisor";
import { CrashHandler, DeadLetter, ErrorReporter } from "../src/types";

type Counter = { count: number };

const silent: ErrorReporter = { onError: () => {} };

const countUp = (state: Counter, msg: string): Counter => {
    if (msg === 'boom') throw new Error('Crash!');
    return { count: state.count + 1 };
};

describe('Actor backpressure', () => {
    it('send() enqueues past the high watermark but reports false', async () => {
        const scheduler = new Scheduler();
        const actor = new Actor<Counter, string>(countUp, {
            initialState: { count: 0 },
            highWatermark: 2,
        }, scheduler);

        expect(actor.send('a')).toBe(true);
        expect(actor.send('b')).toBe(true);
        // over the watermark: accepted anyway, but the sender is told to slow down
        expect(actor.send('c')).toBe(false);
        expect(actor.pendingCount).toBe(3);

        await scheduler.whenIdle();
        expect(actor.state.count).toBe(3); // nothing was lost
    });

    it('trySend() refuses instead, checking capacity before enqueuing', async () => {
        const scheduler = new Scheduler();
        const actor = new Actor<Counter, string>(countUp, {
            initialState: { count: 0 },
            highWatermark: 2,
        }, scheduler);

        expect(actor.trySend('a')).toBe(true);
        expect(actor.trySend('b')).toBe(true);
        expect(actor.trySend('c')).toBe(false);
        expect(actor.pendingCount).toBe(2); // 'c' never made it in

        await scheduler.whenIdle();
        expect(actor.state.count).toBe(2);
    });
});

describe('Actor lifecycle', () => {
    it('suspended: accepts messages but does not drain them', async () => {
        const scheduler = new Scheduler();
        const actor = new Actor<Counter, string>(countUp, { initialState: { count: 0 } }, scheduler);

        actor.suspend();
        actor.send('a');
        actor.send('b');
        await scheduler.whenIdle();

        expect(actor.pendingCount).toBe(2); // queued
        expect(actor.state.count).toBe(0);  // but untouched

        actor.restart({ policy: 'resume' });
        await scheduler.whenIdle();
        expect(actor.state.count).toBe(2);
    });

    it('stopped: refuses new messages and drains nothing further', async () => {
        const scheduler = new Scheduler();
        const actor = new Actor<Counter, string>(countUp, { initialState: { count: 0 } }, scheduler);

        actor.send('a');
        actor.stop();
        await scheduler.whenIdle();

        expect(() => actor.send('b')).toThrow(/stopped/);
        expect(actor.state.count).toBe(0); // hard stop — the queued 'a' is not processed
    });

    it('dead-letters the backlog it will never process when stopped', async () => {
        const letters: DeadLetter[] = [];
        const crashHandler: CrashHandler = {
            handleCrash: async () => 'drop',
            noteDeadLetter: (letter) => { letters.push(letter); },
        };
        const scheduler = new Scheduler();
        const actor = new Actor<Counter, string>(
            countUp, { initialState: { count: 0 } }, scheduler, crashHandler,
        );

        actor.send('a');
        actor.send('b');
        actor.stop();

        expect(letters.map(l => l.message)).toEqual(['a', 'b']);
        expect(letters.every(l => l.reason === 'retired')).toBe(true);
    });
});

describe('Actor under supervision', () => {
    it('replays the failed message at the HEAD, ahead of what is queued behind it', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { policy: 'replay', backoff: 'none', scheduler });

        const order: string[] = [];
        let firstAttempt = true;

        const actor = supervisor.spawn<Counter, string>((state, msg) => {
            if (msg === 'flaky' && firstAttempt) { firstAttempt = false; throw new Error('transient'); }
            order.push(msg);
            return state;
        }, { initialState: { count: 0 } });

        actor.send('flaky');
        actor.send('next'); // queued behind the failure
        await scheduler.whenIdle();

        expect(order).toEqual(['flaky', 'next']);
    });

    it('a retired actor strands nothing — its whole backlog is reported', async () => {
        // Regression: the backlog used to sit in the mailbox forever, never
        // processed and never reported, because nothing re-enqueues a stopped
        // actor with the scheduler.
        const letters: DeadLetter[] = [];
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, {
            policy: 'resume', maxRestarts: 1, backoff: 'none',
            onDeadLetter: (l) => letters.push(l),
            scheduler,
        });

        const actor = supervisor.spawn<Counter, string>(() => {
            throw new Error('always fails');
        }, { initialState: { count: 0 } });

        actor.send('a');
        actor.send('b');
        actor.send('c');
        actor.send('d');
        await scheduler.whenIdle();

        // every message accounted for: two crashed, two discarded on retirement
        expect(letters).toHaveLength(4);
        expect(letters.map(l => l.message).sort()).toEqual(['a', 'b', 'c', 'd']);
        expect(() => actor.send('e')).toThrow(/stopped/);
    });
});

describe('Actor without a supervisor', () => {
    it('spawn() stops the actor on crash rather than restarting it', async () => {
        const scheduler = new Scheduler();
        const ref = spawn<Counter, string>(countUp, { initialState: { count: 0 } }, scheduler);

        ref.send('boom');
        await scheduler.whenIdle();

        // orphan actors have nobody to restart them, so they retire themselves
        expect(() => ref.send('a')).toThrow(/stopped/);
    });
});
