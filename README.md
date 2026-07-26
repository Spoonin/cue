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

`spawn` runs unsupervised: if the handler throws, the actor stops itself and logs the error (`packages/core/src/actor.ts:96-105`). For anything you want restarted on crash, spawn under a `Supervisor` instead.

## Core building blocks

| Primitive | Use it when you need... | File |
|---|---|---|
| `Actor` (`spawn`) | fire-and-forget state + `send()` | `src/actor.ts` |
| `Server` (`spawnServer`) | request/reply (`call`) alongside fire-and-forget (`cast`) | `src/server.ts` |
| `Agent` (`spawnAgent`) | a bare mutable cell (`get`/`update`) with no message-type ceremony | `src/agent.ts` |
| `Supervisor` | crash isolation + restart strategy for a group of children | `src/supervisor.ts` |
| `Registry` | look up an actor ref by name instead of passing refs around | `src/registry.ts` |

### Supervisor: crash isolation

```typescript
import { Supervisor } from "@cue/core";

const system = new Supervisor(
  { handleCrash: async (err) => console.error("root crash:", err) },
  { strategy: "restartOne" } // 'restartOne' | 'restartAll' | 'restartRest' | 'escalate'
);

const worker = system.spawn<State, Msg>(handler, { initialState: { count: 0 } });
```

Every `Supervisor` needs a `CrashHandler` in its constructor — there's no default, because someone has to own errors that reach the top (`src/supervisor.ts:25-27`). Use `escalate` on a child supervisor to hand a crash up to its parent instead of restarting locally.

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

**`send()` never drops a message, even past the high watermark.** `highWatermark` is a backpressure *signal*, not a limit — `send()` still enqueues and returns `false` so the caller knows to slow down (`src/mailbox.ts:18-24`). If you need sends to actually be rejected when the mailbox is full, use `trySend()` instead, which checks capacity *before* enqueuing (`src/actor.ts:59-66`).

**Restart resets state to the original `initialState`, not the last good state before the crash.** There's no crash-recovery replay — `restart()` on an `Actor`, `Server`, or `Agent` all reinitialize from scratch (`src/actor.ts:43-48`, `src/server.ts:134-139`).

**All actors share one scheduler unless you pass your own.** `DEFAULT_SCHEDULER` (`throughput: 100`, `tickBudget: 16ms`) is a module-level singleton (`src/scheduler.ts:78`), so unrelated actors in the same process compete for the same tick budget. Pass a dedicated `Scheduler` (as in `examples/fair-scheduling.ts`) if one actor's message volume shouldn't starve another's.

**`Server`/`Agent` reject in-flight `call`/`get` promises on stop or restart**, with `Error("... is stopped")` — callers awaiting a reply at that moment need to handle the rejection, not assume the promise hangs forever (`src/server.ts:121-132`, `src/agent.ts:96-103`).

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

## Further reading

- `docs/adr/001-supervisor-init.md` — why the supervisor API is imperative (`spawn`/`spawnSupervisor`) rather than a declarative child spec.
