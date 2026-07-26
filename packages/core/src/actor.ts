import { Mailbox } from "./mailbox.js";
import { DEFAULT_SCHEDULER, Scheduler } from "./scheduler.js";
import { ActorFn, ActorOptions, ActorRef, CrashHandler, Drainable, RestartOptions, Supervisable } from "./types.js";

export type { ActorFn, ActorOptions, ActorRef, Drainable };

// Auto-incrementing id generator — Phase 1 only.
// Phase 4: must be globally unique across worker threads.
let _nextId = 0;
function nextId(): string {
    return `actor-${_nextId++}`;
}

export class Actor<State, Msg> implements Drainable, Supervisable {
    readonly id: string;
    readonly ref: ActorRef<Msg>;
    readonly #initState: State;
    #state: State;
    readonly #mailbox: Mailbox<Msg>;
    readonly #fn: ActorFn<State, Msg>;
    readonly #scheduler: Scheduler;
    #stopped = false;
    // Gates the clean-drain notification so the healthy path costs one boolean test
    // rather than a supervisor call per message.
    #failedSinceCleanDrain = false;
    #suspended = false;
    readonly #afterMessage?: (state: State) => void;

    constructor(fn: ActorFn<State, Msg>, options: ActorOptions<State, Msg>, scheduler: Scheduler = DEFAULT_SCHEDULER, private readonly crashHandler?: CrashHandler) {
        this.id = nextId();
        this.#fn = fn;
        this.#initState = options.initialState;
        this.#state = options.initialState;
        this.#mailbox = new Mailbox(options.highWatermark);
        this.#afterMessage = options.afterMessage;
        this.#scheduler = scheduler;
        this.ref = {
            id: this.id,
            send:    (msg) => this.send(msg),
            trySend: (msg) => this.trySend(msg),
            stop:    ()    => this.stop(),
        };
    }
    
         
    
    // `reset` wipes state and pending work. `resume`/`replay` keep the mailbox so
    // messages queued behind the failure survive in their original order — the
    // failed message itself is pushed back to the head by drain(), not here.
    restart(opts?: RestartOptions): void {
        const policy = opts?.policy ?? 'reset';
        this.#stopped = false;
        this.#suspended = false;

        if (policy === 'reset') {
            this.#state = this.#initState;
            this.#mailbox.clear();
        } else if (opts && 'state' in opts) {
            this.#state = opts.state as State;
        }

        this.#scheduler.enqueue(this);
    }

    send(msg: Msg): boolean {
        if (this.#stopped) {
            throw new Error(`Actor ${this.id} is stopped`);
        }
        const result = this.#mailbox.push(msg);
        // While suspended there is no point waking the scheduler — drain() would
        // just decline. restart() re-enqueues us when the backoff elapses.
        if (!this.#suspended) this.#scheduler.enqueue(this);
        return result;
    }

    trySend(msg: Msg): boolean {
        if (this.#stopped) {
            throw new Error(`Actor ${this.id} is stopped`);
        }
        const result = this.#mailbox.tryPush(msg);
        if (result && !this.#suspended) this.#scheduler.enqueue(this);
        return result;
    }

    // soft stop — stops processing new messages, but drains the mailbox first.
    stop(): void {
        this.#stopped = true;
    }

    // Keep queueing, stop draining. Cleared by restart().
    suspend(): void {
        this.#suspended = true;
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

    // Called by the Scheduler — processes one message, returns true if more remain.
    async drain(): Promise<boolean> {
        if (this.#suspended) return false; // backing off — restart() will re-enqueue us

        const msg = this.#mailbox.pull();
        if (msg === undefined) return false;

        const stateBefore = this.#state;

        try {
            const result = this.#fn(this.#state, msg);
            this.#state = result instanceof Promise ? await result : result;
            this.#afterMessage?.(this.#state);
            if (this.#failedSinceCleanDrain) {
                this.#failedSinceCleanDrain = false;
                this.crashHandler?.noteCleanDrain?.(this.id);
            }
        } catch (err) {
            this.#failedSinceCleanDrain = true;
            if (this.crashHandler) {
                // supervisor decides — do NOT stop the actor here.
                // It restarts us first, then tells us what to do with this message.
                const directive = await this.crashHandler.handleCrash({
                    childId: this.id,
                    error: err,
                    message: msg,
                    previousState: stateBefore,
                });
                if (directive === 'replay') {
                    this.#mailbox.pushFront(msg);
                    return !this.#mailbox.isEmpty;
                }
            } else {
                // orphan actor — stop and log
                this.stop();
                console.error(`[Actor ${this.id}] crashed:`, err);
            }
            return false;
        }

        return !this.#mailbox.isEmpty;
    }
}

// The public entry point — callers use this, never `new Actor()`.
// Returns a ref, not the actor itself.
export function spawn<State, Msg>(
    fn: ActorFn<State, Msg>,
    options: ActorOptions<State, Msg>,
    scheduler: Scheduler = DEFAULT_SCHEDULER
): ActorRef<Msg> {
    const actor = new Actor(fn, options, scheduler);
    return actor.ref;
}
