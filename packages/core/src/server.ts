
import { Mailbox } from "./mailbox.js";
import { Scheduler, DEFAULT_SCHEDULER } from "./scheduler.js";
import { CallMsg, CrashHandler, DistributiveOmit, Drainable, Handlers, RestartOptions, ServerRef, Supervisable } from "./types.js";

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
    // Deadline for call(), measured from invocation — not from when the message
    // starts draining — because that is what a caller means by "5s timeout".
    // Pass Infinity to wait forever.
    replyTimeoutMs?: number;
}

// Mailbox entry — wraps the raw message with an optional resolve for calls
type Envelope<Msg> = {
    msg: Msg;
    resolve?: (value: unknown) => void;
    reject?: (reason: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
    // Set when the caller stopped waiting. drain() discards these WITHOUT running
    // the handler: the caller has already been told it failed, so running it
    // anyway would mutate state behind their back. Erlang's gen_server does run
    // it, which is how a timed-out call still charges the card.
    abandoned?: boolean;
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
    // See Actor — gates the clean-drain notification off the hot path.
    #failedSinceCleanDrain = false;
    #suspended = false;
    readonly #initialState: State;
    readonly #replyTimeoutMs: number;

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
        this.#replyTimeoutMs = options.replyTimeoutMs ?? 30_000;
    }

    cast(msg: Msg): boolean {
        if (this.#stopped) {
            throw new Error(`Server ${this.id} is stopped`);
        }
        const envelope: Envelope<Msg> = { msg };
        this.#scheduler.enqueue(this);
        return this.#mailbox.push(envelope);
    }

    call<M extends CallMsg<Msg>>(msg: DistributiveOmit<M, 'reply'>): Promise<M['reply']> {
        if(this.#stopped) {
            return Promise.reject(new Error(`Server ${this.id} is stopped`));
        }
        const promise = new Promise<M['reply']>((resolve, reject) => {
            const envelope: Envelope<Msg> = {
                msg: msg as unknown as Msg,
                resolve,
                reject
            };

            if (Number.isFinite(this.#replyTimeoutMs)) {
                const timer = setTimeout(() => {
                    envelope.abandoned = true;
                    envelope.timer = undefined;
                    const error = new Error(
                        `Server ${this.id} call timed out after ${this.#replyTimeoutMs}ms`
                    );
                    reject(error);
                    this.#crashHandler?.noteDeadLetter?.({
                        childId: this.id,
                        message: envelope.msg,
                        error,
                        reason: 'timeout',
                    });
                }, this.#replyTimeoutMs);
                timer.unref?.();
                envelope.timer = timer;
            }

            this.#mailbox.push(envelope);
            if (!this.#suspended) this.#scheduler.enqueue(this);
        });

        return promise;
    }

    // The deadline runs from call(), so a replayed message stays on its original
    // clock — a retry does not buy the caller extra time.
    #clearTimer(envelope: Envelope<Msg>): void {
        if (envelope.timer !== undefined) {
            clearTimeout(envelope.timer);
            envelope.timer = undefined;
        }
    }

    async drain(): Promise<boolean> {
        if (this.#stopped) return false;
        if (this.#suspended) return false; // backing off — restart() will re-enqueue us

        const envelope = this.#mailbox.pull();
        if (!envelope) return false;

        // The caller already gave up and was rejected. Running the handler now
        // would apply a state change nobody is waiting for.
        if (envelope.abandoned) return this.#mailbox.count > 0;

        const handler = this.#handlers[envelope.msg.type as Msg['type']];

        if(envelope.resolve) {
            const callHandler = handler as (state: State, msg: Msg) => { state: State; reply: unknown };
            try {
                const { state, reply } = await callHandler(this.#state, envelope.msg);
                this.#state = state;
                this.#clearTimer(envelope);
                envelope.resolve(reply);
                this.#noteCleanDrain();
            } catch (err) {
                this.#failedSinceCleanDrain = true;
                if (this.#crashHandler) {
                    // The envelope is already pulled, so its resolvers are still ours to
                    // keep. On replay we re-queue it intact rather than rejecting, and the
                    // caller's promise stays open across the restart.
                    const directive = await this.#crashHandler.handleCrash({
                        childId: this.id,
                        error: err,
                        message: envelope.msg,
                        previousState: this.#state,
                    });
                    if (directive === 'replay') {
                        this.#mailbox.pushFront(envelope); // timer keeps running
                    } else {
                        this.#clearTimer(envelope);
                        envelope.reject?.(err);
                    }
                } else {
                    this.#clearTimer(envelope);
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
                this.#noteCleanDrain();
            } catch (err) {
                this.#failedSinceCleanDrain = true;
                if (this.#crashHandler) {
                    const directive = await this.#crashHandler.handleCrash({
                        childId: this.id,
                        error: err,
                        message: envelope.msg,
                        previousState: this.#state,
                    });
                    if (directive === 'replay') this.#mailbox.pushFront(envelope);
                } else {
                    this.stop();
                    console.error(`Server ${this.id} crashed processing message`, envelope.msg, 'with error', err);
                }
            }
        }

        return this.#mailbox.count > 0;

    }
    #noteCleanDrain(): void {
        if (this.#failedSinceCleanDrain) {
            this.#failedSinceCleanDrain = false;
            this.#crashHandler?.noteCleanDrain?.(this.id);
        }
    }

    #rejectPendingEnvelopes(): void {
        const pendingEnvelopes = this.#mailbox.drainAll();
        for (const envelope of pendingEnvelopes) {
            this.#clearTimer(envelope);
            if (envelope.reject && !envelope.abandoned) {
                envelope.reject(new Error(`Server ${this.id} is stopped`));
            }
        }
    }
    stop(): void {
        this.#stopped = true;
        this.#rejectPendingEnvelopes();
    }

    // Keep queueing, stop draining. Cleared by restart().
    suspend(): void {
        this.#suspended = true;
    }

    // Only `reset` discards queued work. Under resume/replay the pending envelopes —
    // and the call() promises they carry — survive the restart untouched.
    restart(opts?: RestartOptions): void {
        const policy = opts?.policy ?? 'reset';
        this.#stopped = false;
        this.#suspended = false;

        if (policy === 'reset') {
            this.#rejectPendingEnvelopes();
            this.#state = this.#initialState;
        } else if (opts && 'state' in opts) {
            this.#state = opts.state as State;
        }

        this.#scheduler.enqueue(this);
    }
}
