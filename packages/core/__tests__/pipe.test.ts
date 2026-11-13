import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Actor } from "../src/actor";
import { pipeTo } from "../src/pipe";
import { Server } from "../src/server";
import { Supervisor } from "../src/supervisor";
import { DeadLetter } from "../src/types";

type Msg =
    | { type: 'done'; value: string }
    | { type: 'failed'; reason: string }
    | { type: 'get'; reply: string[] };

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Records what arrives, so a test can see which message the work turned into.
function recorder() {
    return new Server<string[], Msg>({
        initialState: [],
        handlers: {
            done: (log, msg) => [...log, `done:${msg.value}`],
            failed: (log, msg) => [...log, `failed:${msg.reason}`],
            get: (log) => ({ state: log, reply: log }),
        },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('pipeTo', () => {
    // pipe's promise must never reject, and nothing it starts may reject unobserved.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    beforeEach(() => {
        unhandled.length = 0;
        process.on('unhandledRejection', onUnhandled);
    });
    afterEach(async () => {
        await new Promise((r) => setTimeout(r, 0)); // let Node report any stragglers
        process.off('unhandledRejection', onUnhandled);
        expect(unhandled).toEqual([]);
    });

    it('delivers the onOk message and resolves true', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);

        const delivered = await to(
            async () => 'hello',
            (value) => ({ type: 'done', value }),
            (e) => ({ type: 'failed', reason: reasonOf(e) }),
        );

        expect(delivered).toBe(true);
        expect(await server.ref.call({ type: 'get' })).toEqual(['done:hello']);
    });

    it('accepts a promise as well as a thunk', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);

        await to(Promise.resolve('p'), (value) => ({ type: 'done', value }), (e) => ({ type: 'failed', reason: reasonOf(e) }));

        expect(await server.ref.call({ type: 'get' })).toEqual(['done:p']);
    });

    it('delivers the onError message when the work rejects', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);

        const delivered = await to(
            () => Promise.reject(new Error('boom')),
            (value: string) => ({ type: 'done', value }),
            (e) => ({ type: 'failed', reason: reasonOf(e) }),
        );

        expect(delivered).toBe(true);
        expect(await server.ref.call({ type: 'get' })).toEqual(['failed:boom']);
    });

    it('delivers the onError message when the work throws synchronously', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);

        const delivered = await to(
            (): string => { throw new Error('sync'); },
            (value) => ({ type: 'done', value }),
            (e) => ({ type: 'failed', reason: reasonOf(e) }),
        );

        expect(delivered).toBe(true);
        expect(await server.ref.call({ type: 'get' })).toEqual(['failed:sync']);
    });

    it('resolves false without throwing when the target stopped before the work settled', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);
        const work = deferred<string>();

        const pending = to(() => work.promise, (value) => ({ type: 'done', value }), (e) => ({ type: 'failed', reason: reasonOf(e) }));
        server.stop();
        work.resolve('late');

        await expect(pending).resolves.toBe(false);
    });

    it('routes a throwing onOk to onError', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);

        const delivered = await to(
            async () => 'x',
            () => { throw new Error('bad mapper'); },
            (e) => ({ type: 'failed', reason: reasonOf(e) }),
        );

        expect(delivered).toBe(true);
        expect(await server.ref.call({ type: 'get' })).toEqual(['failed:bad mapper']);
    });

    it('resolves false when onError itself throws', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);

        const delivered = await to(
            () => Promise.reject(new Error('boom')),
            (value: string) => ({ type: 'done', value }),
            () => { throw new Error('bad error mapper'); },
        );

        expect(delivered).toBe(false);
        expect(await server.ref.call({ type: 'get' })).toEqual([]);
    });

    it('keeps the actor answering other messages while the work is pending', async () => {
        const server = recorder();
        const to = pipeTo(server.ref);
        const work = deferred<string>();

        const pending = to(() => work.promise, (value) => ({ type: 'done', value }), (e) => ({ type: 'failed', reason: reasonOf(e) }));

        expect(await server.ref.call({ type: 'get' })).toEqual([]); // answered, not blocked
        work.resolve('later');
        await pending;
        expect(await server.ref.call({ type: 'get' })).toEqual(['done:later']);
    });

    it('delivers to a plain Actor through send', async () => {
        const seen: number[] = [];
        const actor = new Actor<null, number>((state, n) => { seen.push(n); return state; }, { initialState: null });

        const delivered = await pipeTo(actor.ref)(async () => 2, (n) => n * 10, () => -1);
        await new Promise((r) => setTimeout(r, 0)); // let the scheduler drain

        expect(delivered).toBe(true);
        expect(seen).toEqual([20]);
    });

    it('a result for a target stopped mid-flight reaches onDeadLetter, so its effect can be compensated', async () => {
        const letters: DeadLetter[] = [];
        const system = new Supervisor({ onError: () => {} }, { onDeadLetter: (l) => letters.push(l) });
        const server = system.spawnServer<string[], Msg>({
            initialState: [],
            handlers: {
                done: (log, msg) => [...log, msg.value],
                failed: (log) => log,
                get: (log) => ({ state: log, reply: log }),
            },
        });
        const work = deferred<string>();

        const delivery = pipeTo(server)(
            () => work.promise,
            (value) => ({ type: 'done', value }),
            (e) => ({ type: 'failed', reason: reasonOf(e) }),
        );
        system.stopChild(server);
        work.resolve('charge-42'); // the side effect happened regardless

        expect(await delivery).toBe(false);
        expect(letters.map(l => [l.childId, l.message, l.reason])).toEqual([
            [server.id, { type: 'done', value: 'charge-42' }, 'undeliverable'],
        ]);
    });

    describe('.then form', () => {
        it('ok and error deliver from an existing chain', async () => {
            const server = recorder();
            const to = pipeTo(server.ref);
            const onError = to.error((e) => ({ type: 'failed', reason: reasonOf(e) }));

            const ok = await Promise.resolve('a').then(to.ok((value) => ({ type: 'done', value }))).catch(onError);
            const failed = await Promise.reject(new Error('b')).then(to.ok((value: string) => ({ type: 'done', value }))).catch(onError);

            expect([ok, failed]).toEqual([true, true]);
            expect(await server.ref.call({ type: 'get' })).toEqual(['done:a', 'failed:b']);
        });

        it('a throwing onOk reaches error when it is in .catch', async () => {
            const server = recorder();
            const to = pipeTo(server.ref);

            const delivered = await Promise.resolve('a')
                .then(to.ok(() => { throw new Error('bad mapper'); }))
                .catch(to.error((e) => ({ type: 'failed', reason: reasonOf(e) })));

            expect(delivered).toBe(true);
            expect(await server.ref.call({ type: 'get' })).toEqual(['failed:bad mapper']);
        });

        it('ok resolves false when the target stopped', async () => {
            const server = recorder();
            const to = pipeTo(server.ref);
            server.stop();

            const delivered = await Promise.resolve('a').then(to.ok((value) => ({ type: 'done', value })));

            expect(delivered).toBe(false);
        });
    });
});
