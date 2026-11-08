// Type-level test for ServerRef.call. Checked by `pnpm typecheck`
// (tsconfig.typetest.json), never run: jest ignores this directory, and its swc
// transform would strip the types anyway. Each @ts-expect-error must stay an
// error, or tsc reports it as unused.
import type { ServerRef } from '../../src/types.js';

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
const assert = <T extends true>() => {};

type Msg =
    | { type: 'observe'; reply: Map<string, number> }
    | { type: 'resolve'; submissions: string[]; reply: { tick: number } }
    | { type: 'poke' }; // a cast message

// Two call variants sharing one `type`, told apart by another field.
type Shared =
    | { type: 'get'; key: 'a'; reply: number }
    | { type: 'get'; key: 'b'; reply: string };

declare const ref: ServerRef<Msg>;
declare const shared: ServerRef<Shared>;

export async function callReplyFollowsType() {
    // The reply is the one for this message type, not the union of all replies.
    const o = await ref.call({ type: 'observe' });
    assert<Equal<typeof o, Map<string, number>>>();
    const r = await ref.call({ type: 'resolve', submissions: [] });
    assert<Equal<typeof r, { tick: number }>>();

    // An explicit type argument is the `type` literal.
    const e = await ref.call<'observe'>({ type: 'observe' });
    assert<Equal<typeof e, Map<string, number>>>();

    // Same `type` on two variants: the union of their replies, as before.
    const s = await shared.call({ type: 'get', key: 'a' });
    assert<Equal<typeof s, number | string>>();
}

export function callRejectsBadMessages() {
    // @ts-expect-error missing field of the resolve message
    ref.call({ type: 'resolve' });
    // @ts-expect-error a cast message cannot be called
    ref.call({ type: 'poke' });
    // @ts-expect-error unknown type
    ref.call({ type: 'nope' });
    // @ts-expect-error reply must not be passed by the caller
    ref.call({ type: 'observe', reply: new Map() });
    // @ts-expect-error the type argument is the `type` literal, no longer the message type
    ref.call<{ type: 'observe'; reply: Map<string, number> }>({ type: 'observe' });
}

export function castStillTakesCastMessages() {
    ref.cast({ type: 'poke' });
    // @ts-expect-error a call message cannot be cast
    ref.cast({ type: 'observe' });
}
