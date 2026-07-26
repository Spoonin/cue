# cue

A lightweight actor runtime for Node.js. Every message is a cue.

State lives inside actors and is only ever touched by one message handler at a time — no locks, no shared-mutable-state bugs. Actors are supervised, so a crash in one doesn't take down the process.

## Install

```bash
pnpm add @cue/core
```

## Quick start

```typescript
import { spawn } from "@cue/core";

type State = { count: number };
type Msg = { type: "increment" };

const counter = spawn<State, Msg>(
  (state, msg) => {
    switch (msg.type) {
      case "increment": return { count: state.count + 1 };
    }
  },
  { initialState: { count: 0 } }
);

counter.send({ type: "increment" });
```

`spawn` runs unsupervised: if the handler throws, the actor stops itself and logs the error (`packages/core/src/actor.ts:139-143`). For anything you want restarted on crash, spawn under a `Supervisor` instead.

## Core building blocks

| Primitive | Use it when you need... | File |
|---|---|---|
| `Actor` (`spawn`) | fire-and-forget state + `send()` | `src/actor.ts` |
| `Server` (`spawnServer`) | request/reply (`call`) alongside fire-and-forget (`cast`) | `src/server.ts` |
| `Agent` (`spawnAgent`) | a bare mutable cell (`get`/`update`) with no message-type ceremony | `src/agent.ts` |
| `Supervisor` | crash isolation, restart policy, and backoff for a group of children | `src/supervisor.ts` |
| `Registry` | look up an actor ref by name instead of passing refs around | `src/registry.ts` |

### Supervisor: crash isolation

Supervision has two independent axes. **Scope** says *who* a crash affects; **policy** says *what happens* to them.

```typescript
import { Supervisor } from "@cue/core";

const system = new Supervisor(
  { onError: ({ childId, error }) => console.error(`[${childId}]`, error) },
  {
    scope: "one",      // 'one' | 'all' | 'rest'
    policy: "reset",   // 'reset' | 'resume' | 'replay' | 'stop' | 'escalate'
    onDeadLetter: ({ message, reason }) => console.warn("undelivered:", reason, message),
  }
);

const worker = system.spawn<State, Msg>(handler, { initialState: { count: 0 } });
```

| Policy | State | The message that crashed |
|---|---|---|
| `reset` | back to `initialState` | dropped |
| `resume` | kept as it was before the failed message | dropped |
| `replay` | kept | redelivered at the head of the mailbox |
| `stop` | child is retired, not restarted | dropped |
| `escalate` | handed to the parent; `scope` is ignored | parent decides |

Every `Supervisor` needs an `ErrorReporter` in its constructor — there's no default, because someone has to own errors that reach the top (`src/supervisor.ts:74-76`).

**Crashes are only reported to `onError` under `escalate`.** Any restart policy handles the crash locally and tells nobody. Use `onDeadLetter` if you want to see failures a supervisor absorbed — it fires for every message that will never be delivered, with a `reason` of `dropped`, `poison`, `retired`, or `timeout`.

### Keeping restarts bounded

A child that keeps failing is restarted with exponential backoff, and retired once it exceeds its budget:

```typescript
new Supervisor(reporter, {
  policy: "replay",
  maxRestarts: 5,   // consecutive; a clean drain resets the count
  maxAttempts: 3,   // redeliveries of one message before it's treated as poison
  backoff: { initialMs: 100, maxMs: 30_000, factor: 2, jitter: true }, // or 'none'
});
```

The budget counts **consecutive** restarts rather than restarts-per-time-window, because backoff defeats a window: once the delay exceeds it, every restart lands alone in its own window and the budget silently stops bounding anything. One message processed without throwing resets the count instead.

While backing off, a child is **suspended** — it still accepts messages, it just doesn't process them. See `docs/adr/002-crash-recovery-model.md` for why this isn't simply a sleep.

### Server: request/reply

```typescript
import { Supervisor } from "@cue/core";

type State = { total: number };
type Msg =
  | { type: "add"; amount: number }
  | { type: "total"; reply: number };

const server = system.spawnServer<State, Msg>({
  initialState: { total: 0 },
  handlers: {
    add: (state, msg) => ({ ...state, total: state.total + msg.amount }),
    total: (state) => ({ state, reply: state.total }),
  },
});

server.cast({ type: "add", amount: 5 });
const total = await server.call({ type: "total" }); // 5
```

Handlers for `cast` messages return the new `State` directly; handlers for `call` messages (any message with a `reply` field) return `{ state, reply }`. See `examples/address-book.ts` for a full CRUD-style server.

## Non-obvious behaviors

**`send()` never drops a message, even past the high watermark.** `highWatermark` is a backpressure *signal*, not a limit — `send()` still enqueues and returns `false` so the caller knows to slow down (`src/mailbox.ts:18-24`). If you need sends to actually be rejected when the mailbox is full, use `trySend()` instead, which checks capacity *before* enqueuing (`src/actor.ts:76-83`).

**Restart resets state to `initialState` *by default*.** That's `policy: 'reset'`, chosen deliberately: resuming with the state that caused a crash tends to re-crash, which is Erlang's original insight. Use `resume` or `replay` when a failure is more likely transient than structural.

**A timed-out reply never runs its handler.** `replyTimeoutMs` (30s default) applies to `Server.call` and to `Agent.get`/`getAndUpdate`, measured from the call — not from when the message starts draining, since queue depth and backoff are part of what a caller is waiting through. On expiry the message is discarded rather than processed, so a caller told "failed" can't have its side effect applied late. Erlang's `gen_server` does the opposite; see ADR 002 for why we didn't. Pass `Infinity` to wait forever.

`Agent.update` has no deadline — it's fire-and-forget, so nobody is waiting on it.

**All actors share one scheduler unless you pass your own.** `DEFAULT_SCHEDULER` (`throughput: 100`, `tickBudget: 16ms`) is a module-level singleton (`src/scheduler.ts:78`), so unrelated actors in the same process compete for the same tick budget. Pass a dedicated `Scheduler` (as in `examples/fair-scheduling.ts`) if one actor's message volume shouldn't starve another's.

**`Server`/`Agent` reject in-flight `call`/`get` promises on stop, and on a `reset` restart**, with `Error("... is stopped")`. Under `resume` and `replay` those queued promises survive the restart instead — only `reset` is destructive.

**`Registry` holds `WeakRef`s.** A registered actor can be garbage-collected once nothing else references its `ActorRef`, silently removing it from the registry (`src/registry.ts:16-19`). Keep a strong reference to any actor you expect `Registry.lookup` to keep finding.

## Development

```bash
pnpm install
pnpm --filter @cue/core build      # tsup → dist/
pnpm --filter @cue/core test       # jest
pnpm --filter @cue/core typecheck
```

Run an example directly with `tsx`:

```bash
pnpm example examples/ping-pong.ts
```

Note that `__tests__` is outside the `tsconfig.json` `include`, and jest transpiles via swc without type checking — so **test files are not type-checked by anything**. `pnpm typecheck` covers `src` only.

## Further reading

- `CONTEXT.md` — the vocabulary this project commits to (scope vs policy vs directive, suspended vs stopped, and so on).
- `docs/adr/001-supervisor-init.md` — why the supervisor API is imperative (`spawn`/`spawnSupervisor`) rather than a declarative child spec.
- `docs/adr/002-crash-recovery-model.md` — the four places this deliberately diverges from OTP and Akka, and why.
