import { describe, expect, it } from '@jest/globals';
import { Supervisor } from "../src/supervisor";
import { Server } from "../src/server";
import { Crash, ErrorReporter } from "../src/types";

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
