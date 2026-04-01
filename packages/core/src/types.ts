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
