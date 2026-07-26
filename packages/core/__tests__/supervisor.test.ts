import { describe, expect, it } from '@jest/globals';
import { Scheduler } from "../src/scheduler";
import { Supervisor } from "../src/supervisor";
import { Crash, ErrorReporter } from "../src/types";

type Counter = { count: number };

const testFn = (state: Counter, msg: string) => {
    if (msg === 'trigger') throw new Error('Crash!');
    else if (msg === 'increment') return { count: state.count + 1 };
    else return state;
};

// Backoff is ON by default. Tests below assert restart *behaviour*, not timing,
// so they pass `backoff: 'none'` to keep restarts synchronous. Backoff itself is
// covered in its own block at the bottom of this file.
const silent: ErrorReporter = { onError: () => {} };

function recorder() {
    const seen: Crash[] = [];
    return { seen, reporter: { onError: (c: Crash) => { seen.push(c); } } satisfies ErrorReporter };
}

describe('Supervisor scope', () => {
    it('scope "one" restarts only the crashed child', async () => {
        let a: Counter = { count: 0 };
        let b: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', scope: 'one', scheduler });
        const actorA = supervisor.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });
        const actorB = supervisor.spawn<Counter, string>(testFn, { initialState: b, afterMessage: (s) => b = s });

        actorA.send('increment');
        actorB.send('increment');
        await scheduler.whenIdle();

        actorA.send('trigger');
        await scheduler.whenIdle();

        actorA.send('nop');
        actorB.send('nop');
        await scheduler.whenIdle();

        expect(a.count).toBe(0); // reset
        expect(b.count).toBe(1); // untouched
    });

    it('scope "all" restarts every child', async () => {
        let a: Counter = { count: 0 };
        let b: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', scope: 'all', scheduler });
        const actorA = supervisor.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });
        const actorB = supervisor.spawn<Counter, string>(testFn, { initialState: b, afterMessage: (s) => b = s });

        actorA.send('increment');
        actorB.send('increment');
        await scheduler.whenIdle();

        actorA.send('trigger');
        await scheduler.whenIdle();

        actorA.send('nop');
        actorB.send('nop');
        await scheduler.whenIdle();

        expect(a.count).toBe(0);
        expect(b.count).toBe(0);
    });

    it('scope "rest" restarts the crashed child and everything spawned after it', async () => {
        let a: Counter = { count: 0 };
        let b: Counter = { count: 0 };
        let c: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', scope: 'rest', scheduler });
        const actorA = supervisor.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });
        const actorB = supervisor.spawn<Counter, string>(testFn, { initialState: b, afterMessage: (s) => b = s });
        const actorC = supervisor.spawn<Counter, string>(testFn, { initialState: c, afterMessage: (s) => c = s });

        actorA.send('increment');
        actorB.send('increment');
        actorC.send('increment');
        await scheduler.whenIdle();

        actorB.send('trigger');
        await scheduler.whenIdle();

        actorA.send('nop');
        actorB.send('nop');
        actorC.send('nop');
        await scheduler.whenIdle();

        expect(a.count).toBe(1); // spawned before the crash — untouched
        expect(b.count).toBe(0);
        expect(c.count).toBe(0);
    });
});

describe('Supervisor policy', () => {
    it('"reset" returns the child to initialState', async () => {
        let a: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'reset', scheduler });
        const actor = supervisor.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(1);

        actor.send('trigger');
        await scheduler.whenIdle();

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(1); // wiped to 0, then +1
    });

    it('"resume" keeps the state the child held before the failed message', async () => {
        let a: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'resume', scheduler });
        const actor = supervisor.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(1);

        actor.send('trigger');
        await scheduler.whenIdle();

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(2); // 1 survived the crash, then +1
    });

    it('"stop" retires the child instead of restarting it', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'stop', scheduler });
        const actor = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle();

        expect(() => actor.send('nop')).toThrow(/stopped/);
    });

    it('"escalate" hands the crash to the parent, which hands it to the root reporter', async () => {
        const { seen, reporter } = recorder();
        const scheduler = new Scheduler();
        const parent = new Supervisor(reporter, { policy: 'escalate', scheduler });
        const child = parent.spawnSupervisor({ policy: 'escalate' });
        const actor = child.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle();

        expect(seen).toHaveLength(1);
        expect(seen[0].error).toBeInstanceOf(Error);
        expect((seen[0].error as Error).message).toBe('Crash!');
    });

    it('escalation reports the escalating supervisor as the childId, not the original actor', async () => {
        const { seen, reporter } = recorder();
        const scheduler = new Scheduler();
        const parent = new Supervisor(reporter, { policy: 'escalate', scheduler });
        const child = parent.spawnSupervisor({ policy: 'escalate' });
        const actor = child.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle();

        expect(seen[0].childId).toBe(parent.id);
    });
});

describe('Supervisor replay', () => {
    it('redelivers the failed message and resolves the original call()', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'replay', scheduler });

        type Msg = { type: 'flaky'; reply: string };
        let firstAttempt = true;

        const server = supervisor.spawnServer<number, Msg>({
            initialState: 0,
            handlers: {
                // fails once, then succeeds — a transient fault, not a poison message
                flaky: (state) => {
                    if (firstAttempt) { firstAttempt = false; throw new Error('transient'); }
                    return { state, reply: 'ok' };
                },
            },
        });

        await expect(server.call({ type: 'flaky' })).resolves.toBe('ok');
    });

    it('preserves ordering — the replayed message runs before the one queued behind it', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'replay', scheduler });

        type Msg =
            | { type: 'flaky'; reply: string }
            | { type: 'after'; reply: string };

        const order: string[] = [];
        let firstAttempt = true;

        const server = supervisor.spawnServer<number, Msg>({
            initialState: 0,
            handlers: {
                flaky: (state) => {
                    if (firstAttempt) { firstAttempt = false; throw new Error('transient'); }
                    order.push('flaky');
                    return { state, reply: 'flaky' };
                },
                after: (state) => {
                    order.push('after');
                    return { state, reply: 'after' };
                },
            },
        });

        const first = server.call({ type: 'flaky' });
        const second = server.call({ type: 'after' }); // queued behind the failure

        await expect(first).resolves.toBe('flaky');
        await expect(second).resolves.toBe('after');
        expect(order).toEqual(['flaky', 'after']);
    });

    it('degrades to resume for siblings, which hold no failed message', async () => {
        let a: Counter = { count: 0 };
        let b: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', scope: 'all', policy: 'replay', maxAttempts: 2, scheduler });
        const actorA = supervisor.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });
        const actorB = supervisor.spawn<Counter, string>(testFn, { initialState: b, afterMessage: (s) => b = s });

        actorA.send('increment');
        actorB.send('increment');
        await scheduler.whenIdle();

        actorA.send('trigger'); // poison — dropped once maxAttempts is reached
        await scheduler.whenIdle();

        expect(b.count).toBe(1); // sibling resumed; under 'reset' this would be 0
    });
});

describe('Supervisor restart budget', () => {
    it('retires a child after maxRestarts consecutive crashes', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', maxRestarts: 2, scheduler });
        const actor = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle(); // 1
        actor.send('trigger');
        await scheduler.whenIdle(); // 2
        actor.send('trigger');
        await scheduler.whenIdle(); // 3 — over budget

        expect(() => actor.send('nop')).toThrow(/stopped/);
    });

    it('counts consecutively — a clean drain resets the budget', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', maxRestarts: 2, scheduler });
        const actor = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle();
        actor.send('trigger');
        await scheduler.whenIdle();

        actor.send('increment'); // clean drain — budget back to zero
        await scheduler.whenIdle();

        actor.send('trigger');
        await scheduler.whenIdle();
        actor.send('trigger');
        await scheduler.whenIdle();

        // five crashes total, but never three in a row
        expect(() => actor.send('nop')).not.toThrow();
    });

    it('retires only the crashed child, leaving siblings running', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', scope: 'one', maxRestarts: 1, scheduler });
        const doomed = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });
        const bystander = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        doomed.send('trigger');
        await scheduler.whenIdle();
        doomed.send('trigger');
        await scheduler.whenIdle();

        expect(() => doomed.send('nop')).toThrow(/stopped/);
        expect(() => bystander.send('nop')).not.toThrow();
    });
});

describe('Supervisor poison messages', () => {
    it('drops a message after maxAttempts rather than replaying it forever', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'replay', maxAttempts: 3, scheduler });

        type Msg = { type: 'poison'; reply: string };
        let calls = 0;

        const server = supervisor.spawnServer<number, Msg>({
            initialState: 0,
            handlers: {
                poison: () => {
                    calls++;
                    // Fail loudly instead of hanging the suite if the cap regresses.
                    if (calls > 20) throw new Error('LOOPED — attempt cap did not hold');
                    throw new Error('always fails');
                },
            },
        });

        await expect(server.call({ type: 'poison' })).rejects.toThrow(/always fails/);
        expect(calls).toBe(3);
    });

    it('keeps the child alive after dropping a poison message', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'replay', maxAttempts: 2, scheduler });

        type Msg =
            | { type: 'poison'; reply: string }
            | { type: 'healthy'; reply: string };

        const server = supervisor.spawnServer<number, Msg>({
            initialState: 0,
            handlers: {
                poison: () => { throw new Error('always fails'); },
                healthy: (state) => ({ state, reply: 'alive' }),
            },
        });

        await expect(server.call({ type: 'poison' })).rejects.toThrow(/always fails/);
        // the poison message is gone, but the server itself was never retired
        await expect(server.call({ type: 'healthy' })).resolves.toBe('alive');
    });

    it('tracks attempts per message — a different failing message restarts the count', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, { backoff: 'none', policy: 'replay', maxAttempts: 2, maxRestarts: 50, scheduler });

        type Msg = { type: 'a'; reply: string } | { type: 'b'; reply: string };
        let aCalls = 0;
        let bCalls = 0;

        const server = supervisor.spawnServer<number, Msg>({
            initialState: 0,
            handlers: {
                a: () => { aCalls++; throw new Error('a fails'); },
                b: () => { bCalls++; throw new Error('b fails'); },
            },
        });

        await expect(server.call({ type: 'a' })).rejects.toThrow(/a fails/);
        await expect(server.call({ type: 'b' })).rejects.toThrow(/b fails/);

        // each got its own budget rather than sharing one counter
        expect(aCalls).toBe(2);
        expect(bCalls).toBe(2);
    });
});

describe('Supervisor subtree', () => {
    it('propagates "stop" through a nested supervisor to its grandchildren', async () => {
        const scheduler = new Scheduler();
        const parent = new Supervisor(silent, { backoff: 'none', policy: 'stop', scheduler });
        const child = parent.spawnSupervisor({ policy: 'escalate' });
        const actor = child.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle();

        // parent stopped the child supervisor, which stopped everything beneath it
        expect(() => actor.send('nop')).toThrow(/stopped/);
    });

    it('forwards "resume" down the subtree so grandchildren keep their state', async () => {
        let a: Counter = { count: 0 };
        const scheduler = new Scheduler();
        const parent = new Supervisor(silent, { backoff: 'none', policy: 'resume', scheduler });
        const child = parent.spawnSupervisor({ policy: 'escalate' });
        const actor = child.spawn<Counter, string>(testFn, { initialState: a, afterMessage: (s) => a = s });

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(1);

        actor.send('trigger');
        await scheduler.whenIdle();

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(2); // survived the subtree restart
    });
});

describe('Supervisor backoff', () => {
    it('does not block the scheduler while a child backs off', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, {
            scope: 'one',
            policy: 'reset',
            backoff: { initialMs: 500, maxMs: 500, factor: 1 },
            scheduler,
        });

        const crasher = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });
        let healthy: Counter = { count: 0 };
        const bystander = supervisor.spawn<Counter, string>(testFn, {
            initialState: healthy,
            afterMessage: (s) => healthy = s,
        });

        crasher.send('trigger');
        bystander.send('increment');
        bystander.send('increment');

        const started = Date.now();
        await scheduler.whenIdle();
        const elapsed = Date.now() - started;

        // If backoff were awaited inside drain(), the whole tick loop would stall
        // for the full 500ms and the bystander would be stuck behind it.
        expect(elapsed).toBeLessThan(200);
        expect(healthy.count).toBe(2);
    });

    it('queues messages while suspended and drains them once the delay elapses', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, {
            policy: 'resume',
            backoff: { initialMs: 30, maxMs: 30, factor: 1 },
            scheduler,
        });

        let a: Counter = { count: 0 };
        const actor = supervisor.spawn<Counter, string>(testFn, {
            initialState: a,
            afterMessage: (s) => a = s,
        });

        actor.send('increment');
        await scheduler.whenIdle();
        expect(a.count).toBe(1);

        actor.send('trigger'); // crashes, then parks on the backoff timer
        await scheduler.whenIdle();

        actor.send('increment'); // accepted, but must not be processed yet
        await scheduler.whenIdle();
        expect(a.count).toBe(1);

        await new Promise(resolve => setTimeout(resolve, 90)); // past the backoff
        await scheduler.whenIdle();

        expect(a.count).toBe(2); // restarted, resumed its state, drained the queue
    });

    it('a child retired by the restart budget is not revived by a pending timer', async () => {
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(silent, {
            maxRestarts: 1,
            backoff: { initialMs: 20, maxMs: 20, factor: 1 },
            scheduler,
        });

        const actor = supervisor.spawn<Counter, string>(testFn, { initialState: { count: 0 } });

        actor.send('trigger');
        await scheduler.whenIdle();
        await new Promise(resolve => setTimeout(resolve, 50)); // let the first restart land
        await scheduler.whenIdle();

        actor.send('trigger'); // second crash — over budget, retired
        await scheduler.whenIdle();
        await new Promise(resolve => setTimeout(resolve, 50)); // any stale timer would fire here
        await scheduler.whenIdle();

        expect(() => actor.send('nop')).toThrow(/stopped/);
    });
});
