import { Mailbox } from "./mailbox.js";
import { Scheduler, DEFAULT_SCHEDULER } from "./scheduler.js";
import { AgentRef, CrashHandler, Drainable, Supervisable } from "./types.js";

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
        return new Promise((resolve, reject) => {
            this.#mailbox.push({fn: (state: State) => ({ state, reply: fn(state) }), resolve: resolve as (value: unknown) => void, reject});
            this.#scheduler.enqueue(this);
        });
    }

    update(fn: (state: State) => State): void {
        this.#mailbox.push({fn: (state: State) => ({ state: fn(state) })});
        this.#scheduler.enqueue(this);
    }

    getAndUpdate<R>(fn: (state: State) => { state: State; reply: R }): Promise<R> {
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
        } catch (error) {
            if (envelope.reject) {
                envelope.reject(error);
            }
            if (this.#crashHandler) {
                await this.#crashHandler.handleCrash(this.id, error, null, this.#state);
            }
        }
        return !this.#mailbox.isEmpty;
    }

    stop(): void { this.#stopped = true; }
    restart(): void { 
        this.#stopped = false;
        this.#state = this.#initialState;
        this.#mailbox.clear();
    }
}
