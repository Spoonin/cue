
import { Mailbox } from "./mailbox.js";
import { Scheduler, DEFAULT_SCHEDULER } from "./scheduler.js";
import { CallMsg, CrashHandler, DistributiveOmit, Drainable, Handlers, ServerRef, Supervisable } from "./types.js";

let _nextId = 0;
function nextId(): string {
    return `server-${_nextId++}`;
}

export interface ServerOptions<State, Msg extends { type: string }> {
    initialState: State;
    handlers: Handlers<State, Msg>;
    scheduler?: Scheduler;
    crashHandler?: CrashHandler;
    id?: string;
    highWatermark?: number;
}

// Mailbox entry — wraps the raw message with an optional resolve for calls
type Envelope<Msg> = {
    msg: Msg;
    resolve?: (value: unknown) => void;
    reject?: (reason: unknown) => void;
};

export class Server<State, Msg extends { type: string }> implements Drainable, Supervisable {
    readonly id: string;
    readonly ref: ServerRef<Msg>;
    readonly #handlers: Handlers<State, Msg>;
    readonly #mailbox: Mailbox<Envelope<Msg>>;
    readonly #scheduler: Scheduler;
    readonly #crashHandler?: CrashHandler;
    #state: State;
    #stopped = false;
    readonly #initialState: State;

    constructor(options: ServerOptions<State, Msg>) {
        this.id = options.id ?? nextId();
        this.ref = {
            id: this.id,
            cast: (msg) => this.cast(msg),
            call: (msg) => this.call(msg),
        };
        this.#handlers = options.handlers;
        this.#mailbox = new Mailbox<Envelope<Msg>>(options.highWatermark);
        this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
        this.#crashHandler = options.crashHandler;
        this.#initialState = options.initialState;
        this.#state = options.initialState;
    }

    cast(msg: Msg): boolean {
        const envelope: Envelope<Msg> = { msg };
        this.#scheduler.enqueue(this);
        return this.#mailbox.push(envelope);
    }

    call<M extends CallMsg<Msg>>(msg: DistributiveOmit<M, 'reply'>): Promise<M['reply']> {
        const promise = new Promise<M['reply']>((resolve, reject) => {
            const envelope: Envelope<Msg> = {
                msg: msg as unknown as Msg,
                resolve,
                reject
            };
            this.#mailbox.push(envelope);
            this.#scheduler.enqueue(this);
        });
        
        return promise;
    }

    async drain(): Promise<boolean> {
        if (this.#stopped) return false;
        
        const envelope = this.#mailbox.pull();
        if (!envelope) return false;

        const handler = this.#handlers[envelope.msg.type as Msg['type']];

        if(envelope.resolve) {
            const callHandler = handler as (state: State, msg: Msg) => { state: State; reply: unknown };
            try {
                const { state, reply } = await callHandler(this.#state, envelope.msg);
                this.#state = state;
                envelope.resolve(reply);
            } catch (err) {
                if (this.#crashHandler) {
                    await this.#crashHandler.handleCrash(this.id, err, envelope.msg, this.#state);
                    envelope.reject?.(err);
                } else {
                    this.stop();
                    envelope.reject?.(err);
                    console.error(`Server ${this.id} crashed processing message`, envelope.msg, 'with error', err);
                }
            }
        } else {
            try {
                const castHandler = handler as (state: State, msg: Msg) => State;
                const newState = await castHandler(this.#state, envelope.msg);
                this.#state = newState as State;
            } catch (err) {
                if (this.#crashHandler) {
                    await this.#crashHandler.handleCrash(this.id, err, envelope.msg, this.#state);
                } else {
                    this.stop();
                    console.error(`Server ${this.id} crashed processing message`, envelope.msg, 'with error', err);
                }
            }
        }

        return this.#mailbox.count > 0; 

    }

    stop(): void {
        this.#stopped = true;
    }

    restart(): void {
        this.#stopped = false;
        this.#mailbox.clear();
        this.#scheduler.enqueue(this);
        this.#state = this.#initialState;
    }
}
