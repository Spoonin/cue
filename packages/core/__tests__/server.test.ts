import { describe, expect, it } from '@jest/globals';
import { Supervisor } from "../src/supervisor";
import { Server } from "../src/server";
import { Crash, CrashHandler, DeadLetter, ErrorReporter } from "../src/types";

describe('Server', () => {
    it('performs cast and call', async () =>{
        type Msg = 
        | { type: 'increment' } 
        | { type: 'getCount', reply: number };

        const server = new Server<number, Msg>({
            initialState: 0,
            handlers: {
                increment: (state) => state + 1,
                getCount: (state) => ({ state, reply: state }),
            }
        });
        server.ref.cast({ type: 'increment' });
        const count = await server.ref.call({ type: 'getCount' });
        
        expect(count).toBe(1);
    });

    it('must preserve ordering of income messages even when calls and casts are interleaved', async () => {
        type Msg = 
        | { type: 'append' }
        | { type: 'prepend', reply: string }
        | { type: 'get', reply: string };

        const server = new Server<string, Msg>({
            initialState: '',
            handlers: {
                append: (state) => state + 'foo',
                prepend: (state) => ({ state: 'bar' + state, reply: state }),
                get: (state) => ({ state, reply: state }),
            }
        });

        server.ref.cast({ type: 'append' }); // state: 'foo'
        const prepended = await server.ref.call({ type: 'prepend' }); // state: 'barfoo', prepended: 'foo'
        server.ref.cast({ type: 'append' }); // state: 'barfoofoo'
        const finalState = await server.ref.call({ type: 'get' }); // state: 'barfoofoo', finalState: 'barfoofoo'

        expect(prepended).toBe('foo');
        expect(finalState).toBe('barfoofoo');
    });

    it('should pass crash information to the root reporter on error', async () => {
        let seen: Crash | undefined;
        const reporter: ErrorReporter = { onError: (crash) => { seen = crash; } };

        const supervisor = new Supervisor(reporter, { policy: 'escalate' });

        type Msg = { type: 'crash'; reply: number };

        const server = supervisor.spawnServer<number, Msg>({initialState: 0, handlers: {
            crash: () => { throw new Error('Crash!') },
        }});

        try {
            await server.call({ type: 'crash' });
        } catch (e) {
            expect(e).toBeInstanceOf(Error);
        }

        expect(seen).toBeDefined();
        expect(seen!.error).toBeInstanceOf(Error);
        expect((seen!.error as Error).message).toBe('Crash!');
        expect(seen!.message).toEqual({ type: 'crash' });
        expect(seen!.previousState).toBe(0);
    });

    // ── stop()/restart() must settle pending call() promises ─────────────────
    // Regression coverage for: call() envelopes left in the mailbox when
    // stop()/restart() runs used to hang forever instead of rejecting.

    it('rejects a call() that is still queued when stop() is invoked before it drains',
        async () => {
            type Msg = { type: 'get', reply: number };
            const server = new Server<number, Msg>({
                initialState: 0,
                handlers: {
                    get: (state) => ({ state, reply: state }),
                }
            });

            const callPromise = server.call({ type: 'get' });
            server.stop();

            await expect(callPromise).rejects.toThrow(/stopped/);
        }   
    );

    it('rejects a call() queued behind a crashing message when policy "reset" restarts the server',
        async () => {
            // 'reset' is the destructive policy — it discards pending work. Under
            // 'resume'/'replay' the queued call would survive instead.
            const supervisor = new Supervisor({ onError: () => {} }, { scope: 'one', policy: 'reset' });

            type Msg = 
            | { type: 'crash'; reply: number }
            | { type: 'get', reply: number };
            
            const server = supervisor.spawnServer<number, Msg>({
                initialState: 0,
                handlers: {
                    crash: () => { throw new Error('Crash!') },
                    get: (state) => ({ state, reply: state }),
                }
            });

            const crashPromise = server.call({ type: 'crash' });
            const queuedCallPromise = server.call({ type: 'get' }); // enqueued behind it, before restart runs
            await expect(crashPromise).rejects.toThrow(/Crash!/);
            await expect(queuedCallPromise).rejects.toThrow(/stopped/); // this one *was* sitting in the mailbox during restart
        }
    );

    it('rejects immediately when call() is invoked after the server is already stopped, without touching the mailbox',
        async () => {
            type Msg = { type: 'get', reply: number };
            const server = new Server<number, Msg>({
                initialState: 0,
                handlers: {
                    get: (state) => ({ state, reply: state }),
                }
            });

            server.stop();

            await expect(server.call({ type: 'get' })).rejects.toThrow(/stopped/);
        }
    );

    it('throws when cast() is invoked after the server is already stopped',
        async () => {
            type Msg = { type: 'get', reply: number };
            const server = new Server<number, Msg>({
                initialState: 0,
                handlers: {
                    get: (state) => ({ state, reply: state }),
                }
            });

            server.stop();

            expect(() => server.cast({ type: 'get', reply: 0 })).toThrow(/stopped/);
        }
    );
});

describe('Server call timeouts', () => {
    type Msg = { type: 'work'; reply: string };

    // Suspending is the deterministic way to hold a message in the mailbox long
    // enough to time out, without depending on scheduler timing.
    function suspendedServer(replyTimeoutMs: number, crashHandler?: CrashHandler) {
        let ran = false;
        const server = new Server<number, Msg>({
            initialState: 0,
            replyTimeoutMs,
            crashHandler,
            handlers: {
                work: (state) => { ran = true; return { state, reply: 'done' }; },
            },
        });
        server.suspend();
        return { server, ran: () => ran };
    }

    it('rejects a call that is not processed within replyTimeoutMs', async () => {
        const { server } = suspendedServer(20);
        await expect(server.call({ type: 'work' })).rejects.toThrow(/timed out/);
    });

    it('never runs the handler for a timed-out call, even once draining resumes', async () => {
        const { server, ran } = suspendedServer(20);

        await expect(server.call({ type: 'work' })).rejects.toThrow(/timed out/);
        expect(ran()).toBe(false);

        // resume draining — the abandoned envelope is still sitting in the mailbox
        server.restart({ policy: 'resume' });
        await new Promise(resolve => setTimeout(resolve, 40));

        // Erlang's gen_server would have run it here and mutated state behind a
        // caller that was already told the call failed.
        expect(ran()).toBe(false);
    });

    it('dead-letters a timed-out call with reason "timeout"', async () => {
        const letters: DeadLetter[] = [];
        const crashHandler: CrashHandler = {
            handleCrash: async () => 'drop',
            noteDeadLetter: (letter) => { letters.push(letter); },
        };

        const { server } = suspendedServer(20, crashHandler);
        await expect(server.call({ type: 'work' })).rejects.toThrow(/timed out/);

        expect(letters).toHaveLength(1);
        expect(letters[0].reason).toBe('timeout');
        expect(letters[0].message).toEqual({ type: 'work' });
    });

    it('Infinity disables the deadline', async () => {
        const { server, ran } = suspendedServer(Infinity);

        const pending = server.call({ type: 'work' });
        await new Promise(resolve => setTimeout(resolve, 40)); // well past any default

        server.restart({ policy: 'resume' });
        await expect(pending).resolves.toBe('done');
        expect(ran()).toBe(true);
    });
});
