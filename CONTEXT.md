# cue

An actor runtime for Node.js. State lives inside actors, is reachable only by message, and is
supervised so a crash is contained rather than fatal.

## Language

### Primitives

**Actor**:
A unit of state with a mailbox, processing one message at a time.
_Avoid_: process, goroutine, worker

**Server**:
An actor that answers requests as well as accepting them — it supports both `call` and `cast`.
_Avoid_: gen_server, service, handler

**Agent**:
An actor holding a single value, mutated by functions rather than typed messages.
_Avoid_: store, cell, atom

**Task**:
A one-shot unit of work that settles a promise and is never restarted.
_Avoid_: job, future

**Ref**:
The handle that escapes an actor — the only way to reach one from outside.
_Avoid_: pid, handle, address

**Mailbox**:
The buffer holding messages a child has accepted but not yet processed.
_Avoid_: queue, inbox

### Supervision

**Scope**:
Which children a crash affects: the crashed one, all of them, or the rest.
_Avoid_: strategy

**Policy**:
What happens to the children a crash affects.
_Avoid_: directive, action, strategy

**Directive**:
What happens to the single in-flight message that crashed. Distinct from Policy, which
concerns children.
_Avoid_: policy, decision

**Crash**:
The record of one failure: the child, the error, the message, and the state held before it.
_Avoid_: fault, exception

### Failure handling

**Suspended**:
Alive and still accepting messages, but not draining them — a child waiting out its backoff.
_Avoid_: paused, stopped, idle

**Clean drain**:
One message processed without throwing. This is what marks a child healthy again and resets
its restart budget.
_Avoid_: success, ack

**Restart budget**:
How many times in a row a child may be restarted before it is retired instead.
_Avoid_: intensity, rate limit

**Poison message**:
A message that fails every time it is delivered, and is given up on rather than retried
forever.
_Avoid_: bad message, stuck message

**Dead letter**:
A message that will never be delivered.
_Avoid_: dropped message, lost message

**Abandoned**:
Said of a message whose caller stopped waiting before it was processed. Abandoned messages are
discarded without running their handler.
_Avoid_: cancelled, expired
