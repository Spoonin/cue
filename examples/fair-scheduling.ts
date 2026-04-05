import { Scheduler } from "../packages/core/src/scheduler.ts";
import { Supervisor } from "../packages/core/src/supervisor.ts";
type State = { count: number }

type Msg = { type: 'increment' }

const scheduler = new Scheduler(5, 20); // process up to 20 messages per tick, or yield after 1000ms

const system = new Supervisor({handleCrash: async (e) => console.error(e)}, { scheduler });

const actorA = system.spawn<State, Msg>((state, msg) => {
    console.log(`Actor A received ${msg.type} message`);
    switch (msg.type) {
        case 'increment':
            return { ...state, count: state.count + 1 };
    }
}, { initialState: { count: 0 } });

const actorB = system.spawn<State, Msg>((state, msg) => {
    console.log(`Actor B received ${msg.type} message`);
    switch (msg.type) {
        case 'increment':
            return { ...state, count: state.count + 1 };
    }
}, { initialState: { count: 0 } });

for (let i = 0; i < 10; i++) {
    actorA.send({ type: 'increment' });
    actorB.send({ type: 'increment' });
}

for (let i = 0; i < 10; i++) {
    const taskA = system.spawnTask(() => {
        console.log('Task A running');
        return 'Task A done';
    });

    taskA.then(console.log);

    const taskB = system.spawnTask(() => {
        console.log('Task B running');
        return 'Task B done';
    });

    taskB.then(console.log);
}

