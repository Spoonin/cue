# ADR 002 — Crash Recovery Model

## Status
Accepted.

## Decision
Supervision is described by two orthogonal axes — `Scope` (which children a crash affects) and
`Policy` (what happens to them) — plus a per-child restart budget, exponential backoff, and a
dead-letter hook.

This ADR exists because the model deviates from OTP and Akka in four places. Each looks like a
mistake if you know the prior art and not the reasoning, so each is recorded here to stop a
future reader from "fixing" it back.

## Deviation 1 — `replay` exists at all

Neither Erlang/OTP nor Akka redelivers the message that crashed an actor. Both drop it. They
omit it deliberately: redelivering a message that deterministically fails is an infinite crash
loop.

We support it because a `Server` handling `call` is the common case here, and dropping the
message means rejecting a caller's promise for what is often a transient fault. Replay is
opt-in, never the default, and is only safe because of deviations 2 and 3.

**Consequence**: `replay` must never ship without a bound. If the attempt cap is ever removed,
replay has to go with it.

## Deviation 2 — the restart budget is per-child, not per-supervisor

OTP counts restarts per supervisor: exceed the intensity and the supervisor kills every child
and terminates itself.

That assumes deep trees where each subsystem has its own supervisor. This runtime's imperative
`spawn()` API (see ADR 001) encourages flat ones — the examples hang everything off a single
`system`. Under per-supervisor counting, one poison message in one actor would take down the
entire process. Exhaustion therefore retires only the offending child; siblings keep running.

**Trade-off**: we lose OTP's "children share fate" property. A supervisor whose children truly
depend on each other must express that with `scope: 'all'`.

## Deviation 3 — consecutive counting, not a sliding window

OTP counts N restarts within T seconds. We count consecutive restarts and reset on a clean
drain, with no time window.

A window is silently defeated by backoff. Once the delay grows past the window — which
exponential backoff guarantees — every restart lands alone inside its own window, the counter
never fills, and the budget stops bounding anything at exactly the moment it is needed most.
Consecutive counting cannot be defeated this way, and it removes a parameter.

## Deviation 4 — a timed-out `call` is not processed

Erlang's `gen_server` settles a timed-out call on the caller's side but still processes the
message when it reaches the head of the queue. This is a well-known trap: the caller is told
the call failed while the handler goes on to perform the side effect.

We mark the envelope abandoned and discard it without invoking the handler, so the caller's
view and the server's state agree. For non-idempotent work — charging a card, decrementing
stock — the gen_server behaviour is a double-charge waiting to happen.

**Trade-off**: a requested state change is silently dropped rather than applied late. Dropping
is recoverable by retrying; a phantom write is not.

## Also worth knowing

Backoff is never awaited inside the crash path. The scheduler drains children sequentially and
`handleCrash` is awaited inside `drain()`, so sleeping there would stall every actor sharing
the scheduler rather than just the failing one. This is why `suspend()` exists as a third
lifecycle state: the child stops draining but keeps accepting messages, and a timer restarts
it later.
