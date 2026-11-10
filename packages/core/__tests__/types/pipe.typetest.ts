// Type-level test for pipeTo. Checked by `pnpm typecheck`, never run (see call.typetest.ts).
import { pipeTo } from '../../src/pipe.js';
import type { ActorRef, ServerRef } from '../../src/types.js';

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
const assert = <T extends true>() => {};

type Msg =
    | { type: 'done'; text: string }
    | { type: 'failed'; reason: string }
    | { type: 'status'; reply: string }; // a call message

declare const server: ServerRef<Msg>;
declare const actor: ActorRef<{ n: number }>;
declare const fetchText: () => Promise<string>;

const to = pipeTo(server);
const failed = (e: unknown) => ({ type: 'failed', reason: String(e) }) as const;

export function onOkReceivesTheWorkValue() {
    // Message literals need no `as const`: the target fixes the message type first.
    to(fetchText, (text) => {
        assert<Equal<typeof text, string>>(); // unwrapped from the promise
        return { type: 'done', text };
    }, (e) => ({ type: 'failed', reason: String(e) }));

    to(fetchText(), (text) => {
        assert<Equal<typeof text, string>>(); // a promise works as well as a thunk
        return { type: 'done', text };
    }, failed);

    to(() => 42, (n) => {
        assert<Equal<typeof n, number>>(); // synchronous work
        return { type: 'done', text: String(n) };
    }, failed);

    // The .then form: the value type comes from the chain.
    fetchText().then(to.ok((text) => {
        assert<Equal<typeof text, string>>();
        return { type: 'done', text };
    })).catch(to.error(failed));
}

export function messagesMustBeCastMessagesOfTheTarget() {
    // @ts-expect-error a call message cannot be piped: nobody waits for its reply
    to(fetchText, () => ({ type: 'status' }), failed);
    // @ts-expect-error unknown message type
    to(fetchText, () => ({ type: 'nope' }), failed);
    // @ts-expect-error a cast message with a field missing
    to(fetchText, () => ({ type: 'done' }), failed);
    // @ts-expect-error onError must produce a message too
    to(fetchText, (text) => ({ type: 'done', text }), () => ({ type: 'nope' }));
    // @ts-expect-error onError is required
    to(fetchText, (text) => ({ type: 'done', text }));
    // @ts-expect-error same rule in the .then form
    fetchText().then(to.ok(() => ({ type: 'status' })));
}

export function actorRefsTakeTheirMessageType() {
    const toActor = pipeTo(actor);
    toActor(() => 1, (n) => ({ n }), () => ({ n: -1 }));
    // @ts-expect-error wrong message for this actor
    toActor(() => 1, (n) => ({ m: n }), () => ({ n: -1 }));
}

export async function resolvesToBoolean() {
    const delivered = await to(fetchText, (text) => ({ type: 'done', text }), failed);
    assert<Equal<typeof delivered, boolean>>();
    const chained = await fetchText().then(to.ok((text) => ({ type: 'done', text }))).catch(to.error(failed));
    assert<Equal<typeof chained, boolean>>();
}
