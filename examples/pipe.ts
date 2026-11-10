import { Supervisor } from "../packages/core/src/supervisor.ts";
import { pipeTo } from "../packages/core/src/pipe.ts";
import type { ServerRef } from "../packages/core/src/types.ts";

// A "thinker" answers slow questions without ever blocking its mailbox: `ask`
// starts the work with pipeTo and returns at once, and the outcome comes back
// later as an `answered` or `failed` message.

type State = { latest: number; thinking: boolean };

type Msg =
    | { type: 'ask'; id: number; question: string; ms: number; deadlineMs?: number }
    | { type: 'answered'; id: number; answer: string }
    | { type: 'failed'; id: number; reason: string }
    | { type: 'status'; reply: string };

// Stand-in for an LLM or HTTP call: slow, can fail, and honours an AbortSignal
// the way fetch does.
function think(question: string, ms: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (question.endsWith('?!')) reject(new Error('no answer to that'));
            else resolve(`${question.length} letters`);
        }, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
}

const reasonOf = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// Kept only so this demo can show what each delivery resolved to.
const deliveries = new Map<number, Promise<boolean>>();

const system = new Supervisor({ onError: ({ childId, error }) => console.error(`[${childId}] crashed:`, error) });

// Handlers get no ref to themselves; closing over `thinker` works because they
// only run after spawnServer has returned.
const thinker: ServerRef<Msg> = system.spawnServer<State, Msg>({
    initialState: { latest: 0, thinking: false },
    handlers: {
        ask: (state, msg) => {
            // A deadline is the work's business: pass a signal in, pipe knows nothing of it.
            const signal = msg.deadlineMs ? AbortSignal.timeout(msg.deadlineMs) : undefined;
            deliveries.set(msg.id, pipeTo(thinker)(
                () => think(msg.question, msg.ms, signal),
                (answer) => ({ type: 'answered', id: msg.id, answer }),
                (error) => ({ type: 'failed', id: msg.id, reason: reasonOf(error) }),
            ));
            console.log(`  asked #${msg.id}: "${msg.question}"`);
            return { latest: msg.id, thinking: true };
        },
        // Results arrive in settle order, not ask order: keep only the latest.
        answered: (state, msg) => {
            if (msg.id !== state.latest) {
                console.log(`  #${msg.id} answered after #${state.latest} was asked: discarded`);
                return state;
            }
            console.log(`  #${msg.id} answered: ${msg.answer}`);
            return { ...state, thinking: false };
        },
        failed: (state, msg) => {
            if (msg.id !== state.latest) return state;
            console.log(`  #${msg.id} failed: ${msg.reason}`);
            return { ...state, thinking: false };
        },
        status: (state) => ({ state, reply: state.thinking ? `thinking about #${state.latest}` : 'idle' }),
    },
});

const status = () => thinker.call({ type: 'status' });

// Waits for #id's outcome to be handled. A call is processed after everything
// queued before it, so the first status() means the ask has started its work,
// and the last one means the delivered result has been handled.
async function settled(id: number) {
    await status();
    await deliveries.get(id);
    await status();
}

async function main() {
    console.log('1. Stays responsive while working, and the result arrives as a message');
    thinker.cast({ type: 'ask', id: 1, question: 'why is the sky blue', ms: 300 });
    console.log(`  status right away: ${await status()}`);
    await settled(1);
    console.log(`  status after: ${await status()}`);

    console.log('2. Stale results are dropped');
    thinker.cast({ type: 'ask', id: 2, question: 'a slow question', ms: 400 });
    thinker.cast({ type: 'ask', id: 3, question: 'a quick one', ms: 100 });
    await settled(2); // #2 is the slower, so #3 has settled too

    console.log('3. Failure is a message too');
    thinker.cast({ type: 'ask', id: 4, question: 'divide by zero?!', ms: 50 });
    await settled(4);
    console.log(`  still running: ${await status()}`);

    console.log('4. Deadline with an AbortSignal');
    thinker.cast({ type: 'ask', id: 5, question: 'a very long question', ms: 500, deadlineMs: 100 });
    await settled(5);

    console.log('5. Target stopped before the work settles');
    thinker.cast({ type: 'ask', id: 6, question: 'never mind', ms: 200 });
    console.log(`  status: ${await status()}`);
    system.stop();
    console.log(`  stopped; delivery of #6 resolved ${await deliveries.get(6)}, nothing thrown`);
}

main();
