import { ActorRef, spawn } from '../packages/core/src/actor.ts';
import { Scheduler } from '../packages/core/src/scheduler.ts';
const performance_timestamp = typeof performance !== 'undefined' ? performance : Date;

const start = performance_timestamp.now();

type StateA = { count: number; peer: ActorRef<MsgB> | null }

type MsgA =
    | { type: 'init'; peer: ActorRef<MsgB> }  // carries ref once
    | { type: 'pong'; count: number }           // just data

type StateB = { count: number; peer: ActorRef<MsgA> | null }

type MsgB =
    | { type: 'init'; peer: ActorRef<MsgA> }
    | { type: 'ping'; count: number }

const scheduler = new Scheduler(1000, 20); // process up to 10 messages per tick, or yield after 100ms

const actorA = spawn((state: StateA, msg: MsgA) => {
    switch (msg.type) {
        case 'init':
            return { ...state, peer: msg.peer };
        case 'pong':
            // console.log(`A received pong ${msg.count}`);
            state.peer?.send({ type: 'ping', count: msg.count + 1 });
            return { ...state, count: state.count + 1 };
    }
}, { initialState: { count: 0, peer: null } }, scheduler);

const actorB = spawn((state: StateB, msg: MsgB) => {
    switch (msg.type) {
        case 'init':
            return { ...state, peer: msg.peer };
        case 'ping':
            // console.log(`B received ping ${msg.count}`);
            if (msg.count >= 100000) {
                console.log('Game over!');
                const end = performance_timestamp.now();
                console.log(`Game duration: ${end - start} ms`);
                state.peer?.stop();
                return state;
            }
            state.peer?.send({ type: 'pong', count: msg.count });
            return { ...state, count: state.count + 1 };
    }
}, {initialState: { count: 0, peer: null }}, scheduler);


actorA.send({ type: 'init', peer: actorB });
actorB.send({ type: 'init', peer: actorA });
actorA.send({ type: 'pong', count: 0 });    
const end = performance_timestamp.now();
console.log(`Setup took ${end - start} ms`);