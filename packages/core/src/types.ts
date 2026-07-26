// Shared contracts — no implementations.
// Both actor.ts and scheduler.ts import from here to avoid circular deps.

// Supervision has two independent axes. Scope answers *who* a crash affects;
// Policy answers *what happens* to them. Keeping them apart avoids the
// contradiction the old single enum produced (`restartAll` + stop).
export type Scope = 'one' | 'all' | 'rest';

export type Policy =
    | 'reset'     // back to initialState; failed message dropped
    | 'resume'    // keep pre-crash state; failed message dropped
    | 'replay'    // keep pre-crash state; failed message redelivered at the mailbox head
    | 'stop'      // retire the child; do not restart
    | 'escalate'; // hand to the parent — scope is ignored

// What happens to the one in-flight message that crashed. Deliberately distinct
// from Policy: Policy is about children, Directive is about a single message.
export type Directive = 'replay' | 'drop';

export interface Crash {
    childId: string;
    error: unknown;
    message: unknown;
    previousState: unknown;
}

export type DeadLetterReason =
    | 'dropped'  // the policy did not replay, so the message was discarded
    | 'poison'   // exceeded maxAttempts and was given up on
    | 'retired'  // its child was stopped, by policy or by exhausting maxRestarts
    | 'timeout'; // the caller stopped waiting before it was processed

// A message that will never be delivered. Without this, a supervisor that
// silently restarts children makes failures invisible.
export interface DeadLetter {
    childId: string;
    message: unknown;
    error: unknown;
    reason: DeadLetterReason;
}

export interface RestartOptions {
    policy?: Policy;
    // Pre-crash state to adopt. Ignored by children that hold no state (Supervisor, Task).
    state?: unknown;
}

// Exponential backoff between restarts. 'none' restarts immediately.
export type Backoff = 'none' | {
    initialMs: number;
    maxMs: number;
    factor: number;
    // Equal jitter — half the delay fixed, half random — so a group of children
    // failing on the same downstream dependency does not retry in lockstep.
    jitter?: boolean;
};

export interface Supervisable {
    stop(): void;
    // Alive and still accepting messages, but not draining them. A third state
    // distinct from stopped: stopped children throw on send(), suspended ones
    // queue. Required so backoff never blocks the scheduler.
    suspend(): void;
    restart(opts?: RestartOptions): void;
}

// Internal contract — implemented only by Supervisor. The return value tells the
// crashing child what to do with the message it is still holding.
export interface CrashHandler {
    handleCrash(crash: Crash): Promise<Directive>;

    // Called after a child processes a message without throwing, which is what
    // resets its restart budget. Children only call this if they have crashed
    // since the last clean drain, so the healthy path stays a boolean test.
    noteCleanDrain?(childId: string): void;
}

// What a caller passes to the root Supervisor: a terminal reporter, not a decider.
// It has no children to restart and no message to replay, so it returns nothing.
export interface ErrorReporter {
    onError(crash: Crash): void | Promise<void>;
}

export type ActorFn<State, Msg> = (state: State, msg: Msg) => State | Promise<State>;

export interface ActorOptions<State, Msg> {
    initialState: State;
    highWatermark?: number;
    afterMessage?: (state: State) => void;
}

// The lightweight handle callers hold.
// This is the "pid" — the only thing that escapes the actor.
export interface ActorRef<Msg> {
    readonly id: string;
    send(msg: Msg): boolean;
    trySend(msg: Msg): boolean;
    stop(): void;
}

// Implemented by Actor — the interface the Scheduler sees.
// Scheduler knows nothing about Actor internals, only that it can drain.
export interface Drainable {
    drain(): Promise<boolean>;
}

export function assertUnreachable(x: never): never {
    throw new Error("Didn't expect to get here");
}

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export type Handlers<State, Msg extends { type: string }> = {
    [M in Msg as M['type']]: M extends { reply: infer R }
        ? (state: State, msg: M) => { state: State; reply: R }
        : (state: State, msg: M) => State
}

export type CastMsg<M> = Exclude<M, { reply: unknown }>;
export type CallMsg<M> = Extract<M, { reply: unknown }>;

export type ServerRef<Msg> = {
    readonly id: string;
    cast(msg: CastMsg<Msg>): boolean;
    call<M extends CallMsg<Msg>>(msg: DistributiveOmit<M, 'reply'>): Promise<M['reply']>;
}

export type AgentRef<State> = {
    readonly id: string;
    get<R>(fn: (state: State) => R): Promise<R>;
    update(fn: (state: State) => State): void;
    getAndUpdate<R>(fn: (state: State) => { state: State; reply: R }): Promise<R>;
}
