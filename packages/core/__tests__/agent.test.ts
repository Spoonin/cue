import { describe, expect, it } from '@jest/globals';
import { Agent } from "../src/agent";
import { Crash, CrashHandler } from "../src/types";

// Agent is exercised directly here, so it needs the internal decider contract
// rather than the root ErrorReporter a user would pass to a Supervisor.
function collector() {
    const seen: Crash[] = [];
    const handler: CrashHandler = { handleCrash: async (crash) => { seen.push(crash); return 'drop'; } };
    return { seen, handler };
}

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
        const { seen, handler } = collector();

        const agent = new Agent(5, { crashHandler: handler });
        agent.update(() => { throw new Error('Update failed'); });

        // wait for the crash to be handled
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            childId: agent.id,
            error: expect.any(Error),
            previousState: 5,
        });
        // An Agent's unit of work is the closure itself — that is what gets replayed.
        expect(typeof seen[0].message).toBe('function');
    });

    it('restarts with the initial state and clears mailbox', async () => {
        const { seen, handler } = collector();

        const agent = new Agent(100, { crashHandler: handler });
        agent.update(() => { throw new Error('Crash!'); });

        // wait for the crash to be handled
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ childId: agent.id, previousState: 100 });

        agent.restart(); // no opts === reset
        const state = await agent.get(state => state);
        expect(state).toBe(100); // state should be reset to initial value
    });

    it('restart with a resume policy adopts the supplied pre-crash state', async () => {
        const agent = new Agent(0);
        agent.update(() => 7);
        expect(await agent.get(s => s)).toBe(7);

        agent.restart({ policy: 'resume', state: 7 });
        expect(await agent.get(s => s)).toBe(7); // not wiped back to 0
    });

    it('rejects a get() that is still queued when stop() is invoked before it drains',
        async () => {
            const agent = new Agent(0);
            const getPromise = agent.get(state => state);
            agent.stop();

            await expect(getPromise).rejects.toThrow(/stopped/);
        }
    );

    it('rejects a getAndUpdate() that crashes when the directive is "drop"',
        async () => {
            const { seen, handler } = collector();

            const agent = new Agent(0, { crashHandler: handler });
            agent.update(() => { throw new Error('Crash!'); });

            const crashPromise = agent.getAndUpdate(() => { throw new Error('Crash!'); });
            await expect(crashPromise).rejects.toThrow(/Crash!/);

            expect(seen.length).toBeGreaterThan(0);
            expect(seen[0].error).toBeInstanceOf(Error);
            expect((seen[0].error as Error).message).toBe('Crash!');
            expect(seen[0].previousState).toBe(0);
        }
    );

    it('keeps the caller promise open and re-runs the closure when the directive is "replay"',
        async () => {
            let firstAttempt = true;
            const handler: CrashHandler = { handleCrash: async () => 'replay' };

            const agent = new Agent(0, { crashHandler: handler });

            // Fails once, then succeeds. The promise must survive the failure rather
            // than rejecting — this is the whole point of replay.
            const promise = agent.getAndUpdate((state) => {
                if (firstAttempt) { firstAttempt = false; throw new Error('transient'); }
                return { state: state + 1, reply: 'recovered' };
            });

            await expect(promise).resolves.toBe('recovered');
            expect(await agent.get(s => s)).toBe(1);
        }
    );

    it('rejects immediately when get()/getAndUpdate() is invoked after the agent is already stopped',
        async () => {
            const agent = new Agent(0);
            agent.stop();

            await expect(agent.get(state => state)).rejects.toThrow(/stopped/);
            await expect(agent.getAndUpdate(state => ({ state: state + 1, reply: state }))).rejects.toThrow(/stopped/);
        }
    );

    it('throws when update() is invoked after the agent is already stopped',
        async () => {
            const agent = new Agent(0);
            agent.stop();

            expect(() => agent.update(state => state + 1)).toThrow(/stopped/);
        }
    );
});