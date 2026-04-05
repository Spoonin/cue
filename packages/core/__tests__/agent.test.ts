import { Agent } from "../src/agent";
import { CrashHandler } from "../src/types";

describe('Agent', () => {
    it('initializes with the given state', async () => {
        const agent = new Agent<number>(42);
        const state = await agent.get(state => state);
        expect(state).toBe(42);
    });

    it('updates state with update()', async () => {
        const agent = new Agent(1);
        agent.update(state => state + 1);
        const state = await agent.get(state => state);
        expect(state).toBe(2);
    });

    it('returns a reply with getAndUpdate()', async () => {
        const agent = new Agent(10);
        const reply = await agent.getAndUpdate(state => ({ state: state * 2, reply: `Value was ${state}` }));
        expect(reply).toBe('Value was 10');
        const state = await agent.get(state => state);
        expect(state).toBe(20);
    });

    it('handles crashes with a crash handler', async () => {
        let crashInfo: unknown;
        const crashHandler: CrashHandler = {
            handleCrash: async (id, err, msg, prevState) => {
                crashInfo = { id, err, msg, prevState };
            }
        };

        const agent = new Agent(5, { crashHandler });
        agent.update(() => { throw new Error('Update failed'); });

        // wait for the crash to be handled
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(crashInfo).toMatchObject({
            id: agent.id,
            err: expect.any(Error),
            msg: null,
            prevState: 5
        });
    });

    it('restarts with the initial state and clears mailbox', async () => {
        let crashInfo: unknown;
        const crashHandler: CrashHandler = {
            handleCrash: async (id, err, msg, prevState) => {
                crashInfo = { id, err, msg, prevState };
            }
        };

        const agent = new Agent(100, { crashHandler });
        agent.update(() => { throw new Error('Crash!'); });

        // wait for the crash to be handled
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(crashInfo).toMatchObject({
            id: agent.id,
            err: expect.any(Error),
            msg: null,
            prevState: 100
        });

        agent.restart();
        const state = await agent.get(state => state);
        expect(state).toBe(100); // state should be reset to initial value
    });
});