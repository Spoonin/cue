import { Scheduler } from "../src/scheduler";
import { Supervisor } from "../src/supervisor";
import { CrashHandler } from "../src/types";

const testFn = (state: {count: number}, msg: string) => {
    if (msg === 'trigger') throw new Error('Crash!');
    else if (msg === 'increment') return { count: state.count + 1 };
    else return state;
};

const crashHandler: CrashHandler = {
    handleCrash: async (id, err, msg, prevState) => {
        console.log(`Actor ${id} crashed with error:`, err);
    }
};

describe('Supervisor', () => {
    it('restarts a child on crash with restartOne strategy', async () => {
        let state: { count: number } = { count: 0 };
        const scheduler = new Scheduler(); // Access the private scheduler for testing purposes
        const supervisor = new Supervisor(crashHandler, { scheduler });
        const actor = supervisor.spawn<{count: number}, string>(testFn, {initialState: state, afterMessage: (updState) => state = updState});

        await actor.send('increment');
        await scheduler.whenIdle();
        expect(state.count).toBe(1);

        // Send a message to trigger the crash
        await actor.send('trigger');
        await scheduler.whenIdle();

        await actor.send('nop');
        await scheduler.whenIdle();

        expect(state.count).toBe(0);
    });

    it('restarts all children on crash with restartAll strategy', async () => {
        let stateA: { count: number } = { count: 0 };
        let stateB: { count: number } = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(crashHandler, { strategy: 'restartAll', scheduler });
        const actorA = supervisor.spawn<{count: number}, string>(testFn, {initialState: stateA, afterMessage: (updState) => stateA = updState});
        const actorB = supervisor.spawn<{count: number}, string>(testFn, {initialState: stateB, afterMessage: (updState) => stateB = updState});
         
        await actorA.send('increment');
        await actorB.send('increment');
        await scheduler.whenIdle();
        expect(stateA.count).toBe(1);
        expect(stateB.count).toBe(1);

        // Send a message to trigger the crash
        await actorA.send('trigger');
        await scheduler.whenIdle();

        await actorA.send('nop');
        await actorB.send('nop');
        await scheduler.whenIdle();

        expect(stateA.count).toBe(0);
        expect(stateB.count).toBe(0);
    });

    it('restarts the rest of the children on crash with restartRest strategy', async () => {
        let stateA: { count: number } = { count: 0 };
        let stateB: { count: number } = { count: 0 };
        let stateC: { count: number } = { count: 0 };
        const scheduler = new Scheduler();
        const supervisor = new Supervisor(crashHandler, { strategy: 'restartRest', scheduler });
        const actorA = supervisor.spawn<{count: number}, string>(testFn, {initialState: stateA, afterMessage: (updState) => stateA = updState});
        const actorB = supervisor.spawn<{count: number}, string>(testFn, {initialState: stateB, afterMessage: (updState) => stateB = updState});
        const actorC = supervisor.spawn<{count: number}, string>(testFn, {initialState: stateC, afterMessage: (updState) => stateC = updState});

        await actorA.send('increment');
        await actorB.send('increment');
        await actorC.send('increment');
        await scheduler.whenIdle();
        expect(stateA.count).toBe(1);
        expect(stateB.count).toBe(1);
        expect(stateC.count).toBe(1);

        // Send a message to trigger the crash
        await actorB.send('trigger');
        await scheduler.whenIdle();

        await actorA.send('nop');
        await actorB.send('nop');
        await actorC.send('nop');
        await scheduler.whenIdle();

        expect(stateA.count).toBe(1); // not restarted
        expect(stateB.count).toBe(0); // restarted
        expect(stateC.count).toBe(0); // restarted
    });

    it('escalates crashes to parent supervisor with escalate strategy', async () => {
        let crashHandled = false;
        const scheduler = new Scheduler();
        const parentSupervisor = new Supervisor({ handleCrash: async () => { crashHandled = true } }, { strategy: 'escalate', scheduler });
        const childSupervisor = parentSupervisor.spawnSupervisor('escalate');
        const actor = childSupervisor.spawn<{count: number}, string>(testFn, {initialState: { count: 0 }});

        await actor.send('trigger');
        await scheduler.whenIdle();

        expect(crashHandled).toBe(true);
    });
});
