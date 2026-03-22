import { Mailbox } from "./mailbox.js";

export type ActorFn<State, Msg> = (state: State, msg: Msg) => State | Promise<State>;

export interface ActorOptions<State, Msg> {
    initialState: State;
    highWatermark?: number;
    afterMessage?: (state: State) => void;
}

// The lightweight handle callers hold.
// This is the "pid" — the only thing that escapes the actor.
export interface ActorRef<Msg> {
    readonly id: string
    send(msg: Msg): boolean
    trySend(msg: Msg): boolean
    stop(): void
}

// Auto-incrementing id generator — Phase 1 only.
// Phase 4: must be globally unique across worker threads.
let _nextId = 0;
function nextId(): string {
    return `actor-${_nextId++}`;
}

export class Actor<State, Msg> {
    readonly id: string;
    readonly ref: ActorRef<Msg>;
    #state: State;
    #mailbox: Mailbox<Msg>;
    #fn: ActorFn<State, Msg>;
    #busy = false;
    #stopped = false;
    #afterMessage?: (state: State) => void;

    constructor(fn: ActorFn<State, Msg>, options: ActorOptions<State, Msg>) {
        this.id = nextId();
        this.#fn = fn;
        this.#state = options.initialState;
        this.#mailbox = new Mailbox(options.highWatermark);
        this.#afterMessage = options.afterMessage;
        this.ref = {
            id: this.id,
            send:    (msg) => this.send(msg),
            trySend: (msg) => this.trySend(msg),
            stop:    ()    => this.stop(),
        };
    }

    send(msg: Msg): boolean {
        if(this.#stopped) {
            throw new Error(`Actor ${this.id} is stopped`);
        }

        const result = this.#mailbox.push(msg);

        this.#schedule();
        
        return result;
    }

    trySend(msg: Msg): boolean {
        if(this.#stopped) {
            throw new Error(`Actor ${this.id} is stopped`);
        }

        const result = this.#mailbox.tryPush(msg);
        
        if (result) {
            this.#schedule();
        }
        
        return result;
    }

    stop(): void {
        this.#stopped = true;
    }

    get state(): State {
        return this.#state;
    }

    get stopped(): boolean {
        return this.#stopped;
    }

    get pendingCount(): number {
        return this.#mailbox.count;
    }

    #schedule(): void {
        if (!this.#busy) {
            this.#busy = true;
            setImmediate(() => this.#drain());
        }
    }

    async #drain(): Promise<void> {
        const msg = this.#mailbox.pull();
        if (msg === undefined) {
            this.#busy = false;
            return;
        }
        
        try {
            const result = this.#fn(this.#state, msg);
            this.#state = result instanceof Promise ? await result : result;
            
            this.#afterMessage?.(this.#state);
            
            if (!this.#mailbox.isEmpty) {
                setImmediate(() => this.#drain());
            } else {
                this.#busy = false;
            }
        } catch (err) {
            this.#busy = false;
            this.stop();
            // TODO Phase 2+: escalate to supervisor instead
            console.error(`[Actor ${this.id}] crashed:`, err);
        }
    }
}

// The public entry point — callers use this, never `new Actor()`.
// Returns a ref, not the actor itself.
export function spawn<State, Msg>(
    fn: ActorFn<State, Msg>,
    options: ActorOptions<State, Msg>
): ActorRef<Msg> {
    const actor = new Actor(fn, options);
    return actor.ref;
}
