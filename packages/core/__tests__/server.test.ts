import { Supervisor } from "../src/supervisor";
import { Server } from "../src/server";
import { CrashHandler } from "../src/types";

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

    it('should pass crash information to the supervisor handler on error', async () => {
        let crashedErr: unknown;
        const crashHandler: CrashHandler = {
            handleCrash: async (id, err, msg, prevState) => {
                crashedErr = { id, err, msg, prevState };
            }
        };

        
        const supervisor = new Supervisor(crashHandler, {strategy: 'escalate'});

        type Msg = { type: 'crash'; reply: number };
        
        const server = supervisor.spawnServer<number, Msg>({initialState: 0, handlers: {
            crash: () => { throw new Error('Crash!') },
        }});
        
        try {
            await server.call({ type: 'crash' });
        } catch (e) {
            expect(e).toBeInstanceOf(Error);
        }

        expect(crashedErr).toBeDefined();
        expect((crashedErr as any).err).toBeInstanceOf(Error);
        expect((crashedErr as any).err.message).toBe('Crash!');
        expect((crashedErr as any).msg).toEqual({ type: 'crash' });
        expect((crashedErr as any).prevState).toBe(0);
    });
}); 