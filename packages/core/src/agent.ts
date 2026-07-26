import { Mailbox } from "./mailbox.js";
import { Scheduler, DEFAULT_SCHEDULER } from "./scheduler.js";
import { AgentRef, CrashHandler, DeadLetterReason, Drainable, RestartOptions, Supervisable } from "./types.js";

let _nextId = 0;
function nextId(): string {
    return `agent-${_nextId++}`;
}

export interface AgentOptions {
    scheduler?: Scheduler,
    crashHandler?: CrashHandler,
    id?: string,
    // Deadline for get()/getAndUpdate(), measured from the call. update() is
    // fire-and-forget, so it has no deadline — nobody is waiting on it.
    // Pass Infinity to wait forever.
    replyTimeoutMs?: number,
}

type Envelope<State> = {
    fn: (state: State) => { state: State; reply?: unknown };
    resolve?: (value: unknown) => void;
    reject?: (reason: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
    // Set when the caller stopped waiting. drain() discards these without running
    // the function, so a caller told "failed" never has its update applied late.
    abandoned?: boolean;
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
    #suspended = false;
    readonly #mailbox: Mailbox<Envelope<State>>;
    readonly #replyTimeoutMs: number;
    readonly ref: AgentRef<State>;

    constructor(initialState: State, options: AgentOptions = {}) {
        this.#initialState = initialState;
        this.#state = initialState;
        this.id = options.id ?? nextId();
        this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
        this.#crashHandler = options.crashHandler;
        this.#replyTimeoutMs = options.replyTimeoutMs ?? 30_000;
        this.#mailbox = new Mailbox();
        this.ref = { id: this.id, get: this.get.bind(this), update: this.update.bind(this), getAndUpdate: this.getAndUpdate.bind(this) };

    }

    // The deadline runs from the call, so a replayed envelope stays on its
    // original clock — a retry does not buy the caller extra time.
    #armDeadline(envelope: Envelope<State>, reject: (reason: unknown) => void): void {
        if (!Number.isFinite(this.#replyTimeoutMs)) return;
        const timer = setTimeout(() => {
            envelope.abandoned = true;
            envelope.timer = undefined;
            const error = new Error(
                `Agent ${this.id} reply timed out after ${this.#replyTimeoutMs}ms`
            );
            reject(error);
            this.#crashHandler?.noteDeadLetter?.({
                childId: this.id,
                message: envelope.fn,
                error,
                reason: 'timeout',
            });
        }, this.#replyTimeoutMs);
        timer.unref?.();
        envelope.timer = timer;
    }

    #clearTimer(envelope: Envelope<State>): void {
        if (envelope.timer !== undefined) {
            clearTimeout(envelope.timer);
            envelope.timer = undefined;
        }
    }

    get<R>(fn: (state: State) => R): Promise<R> {
        if(this.#stopped) {
            return Promise.reject(new Error(`Agent ${this.id} is stopped`));
        }
        return new Promise((resolve, reject) => {
            const envelope: Envelope<State> = {
                fn: (state: State) => ({ state, reply: fn(state) }),
                resolve: resolve as (value: unknown) => void,
                reject,
            };
            this.#armDeadline(envelope, reject);
            this.#mailbox.push(envelope);
            if (!this.#suspended) this.#scheduler.enqueue(this);
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
            const envelope: Envelope<State> = {
                fn,
                resolve: resolve as (value: unknown) => void,
                reject,
            };
            this.#armDeadline(envelope, reject);
            this.#mailbox.push(envelope);
            if (!this.#suspended) this.#scheduler.enqueue(this);
        });
    }

    async drain(): Promise<boolean> {
        if (this.#stopped) return false;
        if (this.#suspended) return false; // backing off — restart() will re-enqueue us

        const envelope = this.#mailbox.pull();
        if (!envelope) return false;

        // The caller already gave up and was rejected. Running the function now
        // would apply a state change nobody is waiting for.
        if (envelope.abandoned) return !this.#mailbox.isEmpty;

        try {
            const result = envelope.fn(this.#state);
            this.#state = result.state;
            this.#clearTimer(envelope);
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
                if (directive === 'replay') {
                    this.#mailbox.pushFront(envelope); // timer keeps running
                } else {
                    this.#clearTimer(envelope);
                    envelope.reject?.(error);
                }
            } else {
                this.#clearTimer(envelope);
                envelope.reject?.(error);
            }
        }
        return !this.#mailbox.isEmpty;
    }

    // See Server — callers are rejected AND the work is dead-lettered, since
    // update() has no caller to reject.
    #discardPending(reason: DeadLetterReason): void {
        const pendingEnvelopes = this.#mailbox.drainAll();
        for (const envelope of pendingEnvelopes) {
            this.#clearTimer(envelope);
            if (envelope.abandoned) continue; // already dead-lettered when it timed out

            const error = new Error(`Agent ${this.id} is stopped`);
            if (envelope.reject) envelope.reject(error);
            this.#crashHandler?.noteDeadLetter?.({
                childId: this.id,
                message: envelope.fn,
                error,
                reason,
            });
        }
    }

    stop(): void {
        this.#stopped = true;
        this.#discardPending('retired');
    }

    // Keep queueing, stop draining. Cleared by restart().
    suspend(): void {
        this.#suspended = true;
    }

    restart(opts?: RestartOptions): void {
        const policy = opts?.policy ?? 'reset';
        this.#stopped = false;
        this.#suspended = false;

        if (policy === 'reset') {
            this.#state = this.#initialState;
            this.#discardPending('dropped'); // reset is destructive, but not silent
        } else if (opts && 'state' in opts) {
            this.#state = opts.state as State;
        }

        this.#scheduler.enqueue(this);
    }
}
