# Cue — Learning Phases

Each phase maps to a specific Node.js internal. The framework grows with you —
you can stop at any phase and already have something real and useful.

---

## Phase 1 — Event Loop

**What you build:** `Mailbox` + `Scheduler` + base `Actor`

**Node.js internal:** Event loop phases, `setImmediate` vs `queueMicrotask` vs `Promise.resolve()`

**What you're forced to understand:**
- Why `setImmediate` and not a microtask — using a microtask would drain the entire mailbox before any I/O callback fires, starving network/file operations
- How I/O callbacks interleave with your scheduler
- What actor starvation looks like and how to measure it
- The `busy` flag as a single-threaded concurrency lock

**Real problems this phase addresses:**
- Fairness between actors (one actor can't hog the event loop)
- Bounded mailbox with backpressure (`push → false` when full)
- Stop signals preempting a draining mailbox

**Supervision strategies (Akka model — strategy lives on the supervisor, not the child):**

| Strategy | Who is affected | Use when |
|---|---|---|
| `restartOne` | only the crashed child | children are independent |
| `restartAll` | all children under this supervisor | children share state or form a pipeline |
| `restartRest` | crashed child + all spawned after it | downstream actors depend on upstream |

Restart always resets to `initialState` and clears the mailbox. Orphan actors (no supervisor) just stop and log on crash.

`replayLast` (re-enqueue failed message) and `resume` (keep state, drop message) are deferred to a future phase. The infrastructure exists (`Queue.prepend`, `Mailbox.pushFront`) but they are not wired into the supervisor yet.

`Supervisable` interface: both actors and sub-supervisors implement `stop()` and `restart()`, stored in the same `Map<string, Supervisable>` collection.

Imperative spawn API for now. Declarative child spec (for recreating entire tree from config) deferred — see `docs/adr/001-supervisor-init.md`.

**Exit criteria:** You can spawn actors, send messages between them, and observe fair scheduling under load with no infrastructure — one process, one event loop.

---

## Phase 2 — GC Pressure

**What you build:** Dynamic spawn/kill, object pooling, GC instrumentation

**Node.js internal:** V8 heap structure, GC roots, hidden classes, JIT deoptimization

**What you're forced to understand:**
- How object allocation patterns affect GC pause times
- Why inconsistent message object shapes cause V8 to deoptimize hot paths (monomorphic vs polymorphic dispatch)
- Why object pooling matters for a high-throughput message bus
- How to measure GC with `--expose-gc` and `performance.measureMemory()`

**Tools:** `node --expose-gc`, `node --prof` + `node --prof-process`, `v8` module, `perf_hooks`

**Real problems this phase addresses:**
- GC pauses causing latency spikes under load
- Memory leaks from unbounded mailboxes
- Hidden performance cost of inconsistent message shapes

**Exit criteria:** You can profile GC behavior, identify allocation hotspots, and demonstrate the difference between pooled and non-pooled message objects under load.

**Research opportunity — Adaptive Scheduler:**
Current schedulers (Akka, nact) use a fixed `throughput` value. CPUs solve the same problem dynamically via frequency scaling and branch prediction. An adaptive scheduler could observe its own signals and tune itself:
- **IO starvation signal** — measure lag between `setImmediate` scheduling and execution; growing lag → reduce throughput
- **Mailbox depth trend** — queues growing → increase throughput; queues empty → reduce
- **Message processing time** — slow `fn` → reduce throughput so one actor can't block others

CPU analogy map:
| CPU technique | Scheduler equivalent |
|---|---|
| Dynamic frequency scaling | adaptive throughput |
| Branch prediction | pre-fetch next actor while current drains |
| Cache locality | group actors that communicate on same tick |
| NUMA awareness | Phase 4 — prefer actors on same worker thread |

None of the mainstream actor frameworks implement this. Building and benchmarking it in Cue's `bench/` package would be genuinely novel — the signals are all measurable once the benchmarks exist.

---

## Phase 3 — libuv & I/O

**What you build:** I/O actors (file, network), scheduler that correctly yields to I/O

**Node.js internal:** libuv thread pool, I/O callback phase, how `fs` calls are handled

**What you're forced to understand:**
- How libuv's thread pool handles `fs` calls (they don't run on the main thread)
- Why mixing CPU-heavy work and I/O in the same actor is dangerous
- How to yield correctly so I/O completion callbacks aren't starved by a busy actor
- The difference between I/O-bound and CPU-bound actors and how to schedule them differently

**Real problems this phase addresses:**
- CPU actors starving I/O actors (file reads appear to hang)
- Thread pool exhaustion (too many concurrent `fs` calls)
- Correct back-pressure when an I/O actor is slower than its senders

**Exit criteria:** You can build an actor that reads files or handles TCP connections, and demonstrate that CPU-heavy actors don't starve I/O callbacks.

---

## Phase 4 — Worker Threads

**What you build:** Multi-thread transport, shared registry, cross-thread message passing

**Node.js internal:** `worker_threads`, `MessageChannel`, `SharedArrayBuffer`, `Atomics`, structured clone

**What you're forced to understand:**
- Why raw object references can't cross thread boundaries (each worker is a V8 Isolate)
- How `MessageChannel` works for bidirectional communication between workers
- The structured clone algorithm — what's fast, what's slow, what can't be transferred
- `SharedArrayBuffer` + `Atomics.compareExchange` as the JS equivalent of CAS for lock-free state
- Why the `busy` flag breaks across threads and how to replace it atomically

**Real problems this phase addresses:**
- The `busy` flag is not thread-safe — needs `Atomics.compareExchange` on `SharedArrayBuffer`
- Named registry (not object refs) required for location transparency across threads
- Stop signals must preempt across thread boundaries

**Exit criteria:** You can move actor groups to worker threads and send messages between them with the same API as single-threaded mode. The transport is swappable via config.

---

## Phase 5 — Native Addon

**What you build:** Lock-free ring buffer in C++ exposed via N-API

**Node.js internal:** N-API, V8 internals (`v8::ArrayBuffer`, handle scopes, GC boundary), C++ memory model

**What you're forced to understand:**
- Why the JS message queue hits a performance ceiling
- V8's object lifecycle across the GC boundary — what the GC can see and what it can't
- `v8::ArrayBuffer` and how native memory integrates with the JS heap
- Handle scopes — how V8 knows which native-held objects to keep alive
- Lock-free data structures in C++ (memory ordering, `std::atomic`)

**Tools:** N-API, `node-addon-api`, `node-gyp`, `valgrind` or `AddressSanitizer`

**Real problems this phase addresses:**
- JS ring buffer throughput ceiling (allocation + GC overhead per message)
- Sharing a queue between threads without a JS-level lock
- Zero-copy message passing for large payloads

**Exit criteria:** You have a C++ ring buffer that outperforms the JS version under load, integrated into the same `Mailbox` interface — swappable with zero changes to actor code.

---

## Where You Are

```
Phase 1 ← you are here
Phase 2
Phase 3
Phase 4
Phase 5
```

## Reference

- Original design conversation: saved in project memory
- Architecture decisions: `docs/adr/` (create as you make non-obvious choices)
- Benchmarks: `bench/` package
