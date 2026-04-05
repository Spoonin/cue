// Shared contracts — no implementations.
// Both actor.ts and scheduler.ts import from here to avoid circular deps.

// How a supervisor responds when one child crashes — who else is affected.
export type SupervisionStrategy = 'restartOne' | 'restartAll' | 'restartRest' | 'escalate';

export interface Supervisable {
    stop(): void;
    restart(): void;
}

export interface CrashHandler {
    handleCrash(id: string, err: unknown, msg: unknown, prevState: unknown): Promise<void>;
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