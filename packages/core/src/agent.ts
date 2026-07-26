import { Mailbox } from "./mailbox.js";
import { Scheduler, DEFAULT_SCHEDULER } from "./scheduler.js";
import { AgentRef, CrashHandler, Drainable, RestartOptions, Supervisable } from "./types.js";

let _nextId = 0;
function nextId(): string {
    return `agent-${_nextId++}`;
}

export interface AgentOptions { 
    scheduler?: Scheduler, 
    crashHandler?: CrashHandler, 
    id?: string 
}

type Envelope<State> = {
    fn: (state: State) => { state: State; reply?: unknown };
    resolve?: (value: unknown) => void;
    reject?: (reason: unknown) => void;
};



export class Agent<State> implements Drainable, Supervisable {
    readonly id: string;
    readonly #initialState: State;
    #state: State;
    readonly #scheduler: Scheduler;
    readonly #crashHandler?: CrashHandler;
    #stopped = false;
    // See Actor — gates the clean-drain notification off the hot path.
    #failedSinceCleanDrain = false;
    readonly #mailbox: Mailbox<Envelope<State>>;
    readonly ref: AgentRef<State>;

    constructor(initialState: State, options: AgentOptions = {}) {
        this.#initialState = initialState;
        this.#state = initialState;
        this.id = options.id ?? nextId();
        this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
        this.#crashHandler = options.crashHandler;
        this.#mailbox = new Mailbox();
        this.ref = { id: this.id, get: this.get.bind(this), update: this.update.bind(this), getAndUpdate: this.getAndUpdate.bind(this) };

    }

    get<R>(fn: (state: State) => R): Promise<R> {
        if(this.#stopped) {
            return Promise.reject(new Error(`Agent ${this.id} is stopped`));
        }
        return new Promise((resolve, reject) => {
            this.#mailbox.push({fn: (state: State) => ({ state, reply: fn(state) }), resolve: resolve as (value: unknown) => void, reject});
            this.#scheduler.enqueue(this);
        });
    }

    update(fn: (state: State) => State): void {
        if(this.#stopped) {
            throw new Error(`Agent ${this.id} is stopped`);
        }
        this.#mailbox.push({fn: (state: State) => ({ state: fn(state) })});
        this.#scheduler.enqueue(this);
    }

    getAndUpdate<R>(fn: (state: State) => { state: State; reply: R }): Promise<R> {
        if(this.#stopped) {
            return Promise.reject(new Error(`Agent ${this.id} is stopped`));
        }
        return new Promise((resolve, reject) => {
            this.#mailbox.push({fn, resolve: resolve as (value: unknown) => void, reject});
            this.#scheduler.enqueue(this);
        });
    }

    async drain(): Promise<boolean> {
        if (this.#stopped) return false;

        const envelope = this.#mailbox.pull();
        if (!envelope) return false;

        try {
            const result = envelope.fn(this.#state);
            this.#state = result.state;
            if (envelope.resolve) {
                envelope.resolve(result.reply);
            }
            if (this.#failedSinceCleanDrain) {
                this.#failedSinceCleanDrain = false;
                this.#crashHandler?.noteCleanDrain?.(this.id);
            }
        } catch (error) {
            this.#failedSinceCleanDrain = true;
            // Ask the supervisor BEFORE settling the caller's promise — on replay we
            // re-queue the envelope with its resolvers intact instead of rejecting.
            if (this.#crashHandler) {
                const directive = await this.#crashHandler.handleCrash({
                    childId: this.id,
                    error,
                    message: envelope.fn,
                    previousState: this.#state,
                });
                if (directive === 'replay') this.#mailbox.pushFront(envelope);
                else envelope.reject?.(error);
            } else {
                envelope.reject?.(error);
            }
        }
        return !this.#mailbox.isEmpty;
    }

    #rejectPendingEnvelopes(): void {
        const pendingEnvelopes = this.#mailbox.drainAll();
        for (const envelope of pendingEnvelopes) {
            if (envelope.reject) {
                envelope.reject(new Error(`Agent ${this.id} is stopped`));
            }
        }
    }

    stop(): void {
        this.#stopped = true;
        this.#rejectPendingEnvelopes();
    }

    restart(opts?: RestartOptions): void {
        const policy = opts?.policy ?? 'reset';
        this.#stopped = false;

        if (policy === 'reset') {
            this.#state = this.#initialState;
            this.#rejectPendingEnvelopes();
        } else if (opts && 'state' in opts) {
            this.#state = opts.state as State;
        }

        this.#scheduler.enqueue(this);
    }
}
