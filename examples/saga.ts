import { Supervisor } from "../packages/core/src/supervisor.ts";
import { pipeTo } from "../packages/core/src/pipe.ts";
import type { DeadLetter, ServerRef } from "../packages/core/src/types.ts";

// A saga: book a flight, a hotel, then take payment. Each step is an external
// effect a crash cannot roll back, so each has a compensating action, and an
// orchestrator undoes the completed steps, newest first, when a later one fails.
//
// The runtime has no saga primitive. It doesn't need one: pipeTo delivers both
// success and failure as messages, so compensation is just more handlers.
//
// Three failure cases, in increasing order of nastiness:
//   1. A step fails             → undo the completed steps.
//   2. An undo fails            → retry it with a bound, then park the saga as
//                                 `stuck` for a human. Compensation can fail too,
//                                 and retrying forever only hides that.
//   3. The orchestrator stops   → the in-flight step's result is dead-lettered as
//      while a step is in flight  'undeliverable', and onDeadLetter undoes it.

type Step = 'flight' | 'hotel' | 'payment';
const STEPS: Step[] = ['flight', 'hotel', 'payment'];
const MAX_UNDO_ATTEMPTS = 3;

type Trip = {
    who: string;
    failAt?: Step;                         // this step's action fails
    undoFailures?: Partial<Record<Step, number>>; // this step's undo fails N times first
    slow?: boolean;                        // steps take long enough to stop mid-flight
};

// --- Stand-in external services --------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextRef = 1;
const undoCalls: Record<string, number> = {};

async function perform(step: Step, trip: Trip): Promise<string> {
    await sleep(trip.slow ? 200 : 20);
    if (trip.failAt === step) throw new Error(`${step} unavailable`);
    const ref = `${step[0].toUpperCase()}-${nextRef++}`;
    console.log(`    ${step} done: ${ref}`);
    return ref;
}

// Must be idempotent: a retry after a timeout may repeat an undo that succeeded.
async function undo(step: Step, ref: string, trip: Trip): Promise<void> {
    await sleep(20);
    undoCalls[ref] = (undoCalls[ref] ?? 0) + 1;
    if (undoCalls[ref] <= (trip.undoFailures?.[step] ?? 0)) {
        throw new Error(`could not undo ${ref}`);
    }
    console.log(`    ${step} undone: ${ref}`);
}

// --- The orchestrator ------------------------------------------------------

type Phase = 'running' | 'compensating' | 'booked' | 'rolledBack' | 'stuck';
type Saga = { trip: Trip; done: { step: Step; ref: string }[]; phase: Phase; reason?: string };
type State = Record<number, Saga>;

type Msg =
    | { type: 'book'; id: number; trip: Trip }
    | { type: 'stepDone'; id: number; step: Step; ref: string; trip: Trip }
    | { type: 'stepFailed'; id: number; step: Step; reason: string }
    | { type: 'undone'; id: number; step: Step }
    | { type: 'undoFailed'; id: number; step: Step; ref: string; attempt: number; reason: string }
    | { type: 'phase'; id: number; reply: Phase | undefined };

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Results arriving after the orchestrator has stopped. Only a completed step needs
// undoing; a failed one left nothing behind.
function compensateOrphan(letter: DeadLetter) {
    const msg = letter.message as Msg;
    if (letter.reason !== 'undeliverable' || msg.type !== 'stepDone') return;
    console.log(`    orphaned ${msg.step} ${msg.ref}: compensating from onDeadLetter`);
    undo(msg.step, msg.ref, msg.trip).catch((e) =>
        console.error(`    ALERT: orphaned ${msg.ref} needs a human: ${reasonOf(e)}`));
}

const system = new Supervisor(
    { onError: ({ origin, error }) => console.error(`[${origin}] crashed:`, error) },
    { onDeadLetter: compensateOrphan },
);

const orchestrator: ServerRef<Msg> = system.spawnServer<State, Msg>({
    initialState: {},
    handlers: {
        book: (state, msg) => {
            console.log(`  #${msg.id} booking for ${msg.trip.who}`);
            startStep(msg.id, STEPS[0], msg.trip);
            return { ...state, [msg.id]: { trip: msg.trip, done: [], phase: 'running' } };
        },

        stepDone: (state, msg) => {
            const saga = state[msg.id];
            const done = [...saga.done, { step: msg.step, ref: msg.ref }];
            const next = STEPS[STEPS.indexOf(msg.step) + 1];
            if (next) startStep(msg.id, next, saga.trip);
            else console.log(`  #${msg.id} booked`);
            return { ...state, [msg.id]: { ...saga, done, phase: next ? 'running' : 'booked' } };
        },

        stepFailed: (state, msg) => {
            const saga = state[msg.id];
            console.log(`  #${msg.id} ${msg.step} failed (${msg.reason}): compensating`);
            return { ...state, [msg.id]: compensateNext({ ...saga, phase: 'compensating' }, msg.id) };
        },

        undone: (state, msg) => {
            const saga = state[msg.id];
            const done = saga.done.filter((d) => d.step !== msg.step);
            return { ...state, [msg.id]: compensateNext({ ...saga, done }, msg.id) };
        },

        undoFailed: (state, msg) => {
            const saga = state[msg.id];
            if (msg.attempt < MAX_UNDO_ATTEMPTS) {
                console.log(`    undo of ${msg.ref} failed (attempt ${msg.attempt}), retrying`);
                startUndo(msg.id, msg.step, msg.ref, saga.trip, msg.attempt + 1);
                return state;
            }
            // Out of retries. Leave `done` as it is: it is now the list of effects a
            // human has to clean up, which is the most useful thing to hand them.
            console.error(`  #${msg.id} STUCK: ${msg.ref} could not be undone (${msg.reason})`);
            return { ...state, [msg.id]: { ...saga, phase: 'stuck', reason: msg.reason } };
        },

        phase: (state, msg) => ({ state, reply: state[msg.id]?.phase }),
    },
});

function startStep(id: number, step: Step, trip: Trip) {
    pipeTo(orchestrator)(
        () => perform(step, trip),
        (ref) => ({ type: 'stepDone', id, step, ref, trip }),
        (e) => ({ type: 'stepFailed', id, step, reason: reasonOf(e) }),
    );
}

function startUndo(id: number, step: Step, ref: string, trip: Trip, attempt: number) {
    pipeTo(orchestrator)(
        () => undo(step, ref, trip),
        () => ({ type: 'undone', id, step }),
        (e) => ({ type: 'undoFailed', id, step, ref, attempt, reason: reasonOf(e) }),
    );
}

// Undo the newest completed step, one at a time, so steps are released in the
// reverse of the order they were taken. Finishes when nothing is left.
function compensateNext(saga: Saga, id: number): Saga {
    const last = saga.done.at(-1);
    if (!last) {
        console.log(`  #${id} rolled back`);
        return { ...saga, phase: 'rolledBack' };
    }
    startUndo(id, last.step, last.ref, saga.trip, 1);
    return saga;
}

// --- Demo --------------------------------------------------------------------

async function finished(id: number): Promise<Phase | undefined> {
    for (;;) {
        const phase = await orchestrator.call({ type: 'phase', id });
        if (phase !== 'running' && phase !== 'compensating') return phase;
        await sleep(10);
    }
}

async function main() {
    console.log('1. Happy path');
    orchestrator.cast({ type: 'book', id: 1, trip: { who: 'ada' } });
    console.log(`  → ${await finished(1)}`);

    console.log('2. Payment fails: hotel and flight are undone, newest first');
    orchestrator.cast({ type: 'book', id: 2, trip: { who: 'bob', failAt: 'payment' } });
    console.log(`  → ${await finished(2)}`);

    console.log('3. An undo fails once, then succeeds on retry');
    orchestrator.cast({ type: 'book', id: 3, trip: { who: 'cyd', failAt: 'payment', undoFailures: { hotel: 1 } } });
    console.log(`  → ${await finished(3)}`);

    console.log('4. An undo never succeeds: the saga is parked for a human');
    orchestrator.cast({ type: 'book', id: 4, trip: { who: 'dee', failAt: 'hotel', undoFailures: { flight: 99 } } });
    console.log(`  → ${await finished(4)}`);

    console.log('5. Orchestrator stopped while the flight is in flight');
    orchestrator.cast({ type: 'book', id: 5, trip: { who: 'eve', slow: true } });
    await orchestrator.call({ type: 'phase', id: 5 }); // the book has run, flight started
    system.stopChild(orchestrator);
    await sleep(300);
    // Only the step in flight is rescued. Steps the orchestrator had already
    // recorded lived in its memory and died with it; surviving that needs the
    // saga log written somewhere durable, which is outside this runtime.
}

main();
