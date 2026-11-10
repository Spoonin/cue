// Anything a message can be delivered to: a Server's ref (cast) or a plain
// Actor's ref (send). The message type is what that method accepts — for a
// ServerRef that is its cast messages only, so a call message is a type error.
export type Sendable<Msg> =
    | { cast(msg: Msg): boolean }
    | { send(msg: Msg): boolean };

// Delivers the outcome of async work to one target as ordinary messages.
// Handlers are synchronous; this is how they wait on anything.
//
// Every delivery resolves `true` once the message is in the target's mailbox and
// `false` if nothing was delivered: the target was stopped meanwhile, or
// `onError` itself threw. A `cast` past the high watermark still enqueues (see
// Mailbox), so that is `true` too.
export interface Pipe<Msg> {
    // Run `work` and deliver `onOk(value)` or `onError(error)`. The promise never
    // rejects. Pass a thunk rather than a promise where you can: a thunk's
    // synchronous throw is caught too, while building a promise inline throws
    // before pipe ever sees it. If `onOk` throws, that error goes to `onError`,
    // so a broken mapper still reaches the actor as a failure.
    <T>(
        work: PromiseLike<T> | (() => T | PromiseLike<T>),
        onOk: (value: Awaited<T>) => Msg,
        onError: (error: unknown) => Msg,
    ): Promise<boolean>;

    // The same thing as `.then` handlers, for a promise chain you already have:
    //   promise.then(to.ok(onOk)).catch(to.error(onError))
    // Put `error` in `.catch`, not as the second argument of `.then`, so a
    // throwing `onOk` reaches it — that chain is exactly what the call form runs.
    ok<T>(onOk: (value: T) => Msg): (value: T) => boolean;
    error(onError: (error: unknown) => Msg): (error: unknown) => boolean;
}

// Curried on the target so the message type is fixed before the callbacks are
// checked. In a single call TypeScript would infer it alongside them and widen
// `{ type: 'done' }` to `{ type: string }`, which no message union accepts.
//
// No ordering, no cancellation: a result arrives whenever its work settles, so
// the receiver drops stale results by an id it put in the message, and a
// deadline is an AbortSignal the caller passes into the work.
export function pipeTo<Msg>(target: Sendable<Msg>): Pipe<Msg> {
    const deliver = (msg: Msg): boolean => {
        try {
            if ('cast' in target) target.cast(msg);
            else target.send(msg);
            return true;
        } catch {
            return false; // stopped meanwhile: cast/send throw rather than return false
        }
    };

    // An `onOk` throw is left to propagate, into the `.catch` that follows.
    const ok = <T>(onOk: (value: T) => Msg) => (value: T): boolean => deliver(onOk(value));

    const error = (onError: (error: unknown) => Msg) => (err: unknown): boolean => {
        let msg: Msg;
        try {
            msg = onError(err);
        } catch {
            return false; // no message to deliver, and nowhere left to report it
        }
        return deliver(msg);
    };

    const run = <T>(
        work: PromiseLike<T> | (() => T | PromiseLike<T>),
        onOk: (value: Awaited<T>) => Msg,
        onError: (error: unknown) => Msg,
    ): Promise<boolean> =>
        new Promise<Awaited<T>>((resolve) => {
            // Inside the executor, so a synchronous throw from work() rejects.
            resolve((typeof work === 'function' ? work() : work) as Awaited<T>);
        })
            .then(ok(onOk))
            .catch(error(onError));

    return Object.assign(run, { ok, error });
}
