import { ActorRef, spawn } from '../packages/core/src/actor.ts';
const performance_timestamp = typeof performance !== 'undefined' ? performance : Date;

const start = performance_timestamp.now();
// TODO: spawn actor A
// - state: number of pings sent
// - on message { type: 'ping', count } → log it, send { type: 'pong', count } to B

// TODO: spawn actor B
// - state: number of pongs sent
// - on message { type: 'pong', count } → log it, send { type: 'ping', count: count + 1 } back to A
// - stop both actors when count reaches 10

// TODO: kick it off — send the first { type: 'ping', count: 0 } to A
type StateA = { count: number; peer: ActorRef<MsgB> | null }

type MsgA =
    | { type: 'init'; peer: ActorRef<MsgB> }  // carries ref once
    | { type: 'pong'; count: number }           // just data

type StateB = { count: number; peer: ActorRef<MsgA> | null }

type MsgB =
    | { type: 'init'; peer: ActorRef<MsgA> }
    | { type: 'ping'; count: number }


const actorA = spawn((state: StateA, msg: MsgA) => {
    switch (msg.type) {
        case 'init':
            return { ...state, peer: msg.peer };
        case 'pong':
            console.log(`A received pong ${msg.count}`);
            state.peer?.send({ type: 'ping', count: msg.count + 1 });
            return { ...state, count: state.count + 1 };
    }
}, { initialState: { count: 0, peer: null } });

const actorB = spawn((state: StateB, msg: MsgB) => {
    switch (msg.type) {
        case 'init':
            return { ...state, peer: msg.peer };
        case 'ping':
            console.log(`B received ping ${msg.count}`);
            if (msg.count >= 10) {
                console.log('Game over!');
                const end = performance_timestamp.now();
                console.log(`Game duration: ${end - start} ms`);
                state.peer?.stop();
                return state;
            }
            state.peer?.send({ type: 'pong', count: msg.count });
            return { ...state, count: state.count + 1 };
    }
}, {initialState: { count: 0, peer: null }});


actorA.send({ type: 'init', peer: actorB });
actorB.send({ type: 'init', peer: actorA });
actorA.send({ type: 'pong', count: 0 });    
const end = performance_timestamp.now();
console.log(`Setup took ${end - start} ms`);