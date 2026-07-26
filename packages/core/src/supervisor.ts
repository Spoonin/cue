import { Actor } from "./actor.js";
import { DEFAULT_SCHEDULER, Scheduler } from "./scheduler.js";
import { Task } from "./task.js";
import { Server, ServerOptions } from "./server.js";
import { ActorFn, ActorOptions, ActorRef, Backoff, Crash, CrashHandler, DeadLetter, DeadLetterReason, Directive, ErrorReporter, Policy, RestartOptions, Scope, Supervisable, ServerRef, AgentRef } from "./types.js";
import { Agent, AgentOptions } from "./agent.js";

interface SupervisorOptions {
    scope?: Scope;
    policy?: Policy;
    // Consecutive restarts a single child may accumulate before it is retired.
    // Deliberately NOT a sliding window: once backoff delays exceed any window,
    // every restart lands alone inside its own window and the budget silently
    // stops being a budget. A clean drain resets the count instead.
    maxRestarts?: number;
    // How many times one message may be redelivered before it is treated as
    // poison and dropped. Only meaningful under policy 'replay'.
    maxAttempts?: number;
    // Delay before a crashed child is restarted. 'none' restarts immediately.
    backoff?: Backoff;
    // Notified for every message that will never be delivered. Child supervisors
    // inherit this unless they set their own.
    onDeadLetter?: (letter: DeadLetter) => void;
    id?: string;
    scheduler?: Scheduler;
}

// Per-child failure bookkeeping. Absent === healthy.
interface Budget {
    restarts: number;
    lastMessage: unknown;
    attempts: number;
}

// A user hands the root Supervisor an ErrorReporter; nested supervisors hand their
// children themselves. Normalise both into the internal decider contract.
function asCrashHandler(parent: CrashHandler | ErrorReporter): CrashHandler {
    if ('handleCrash' in parent) return parent;
    return {
        handleCrash: async (crash) => {
            await parent.onError(crash);
            return 'drop';
        },
    };
}

export class Supervisor implements CrashHandler, Supervisable {
    readonly #scheduler: Scheduler;
    readonly #scope: Scope;
    readonly #policy: Policy;
    readonly id: string;
    readonly #parent: CrashHandler;
    readonly #children: Map<string, Supervisable> = new Map();
    readonly #maxRestarts: number;
    readonly #maxAttempts: number;
    readonly #backoff: Backoff;
    readonly #onDeadLetter?: (letter: DeadLetter) => void;
    readonly #budgets: Map<string, Budget> = new Map();
    readonly #timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(
        parent: CrashHandler | ErrorReporter,
        {
            scope = 'one',
            policy = 'reset',
            maxRestarts = 5,
            maxAttempts = 3,
            backoff = { initialMs: 100, maxMs: 30_000, factor: 2, jitter: true },
            onDeadLetter,
            id = `supervisor-${nextId()}`,
            scheduler = DEFAULT_SCHEDULER,
        }: SupervisorOptions = {}
    ) {
        if (!parent) {
            throw new Error("Supervisor missing a parent CrashHandler or ErrorReporter");
        }
        this.id = id;
        this.#scheduler = scheduler;
        this.#scope = scope;
        this.#policy = policy;
        this.#maxRestarts = maxRestarts;
        this.#maxAttempts = maxAttempts;
        this.#backoff = backoff;
        this.#onDeadLetter = onDeadLetter;
        this.#parent = asCrashHandler(parent);
    }

    // A child processed a message without throwing, so it is healthy again.
    noteCleanDrain(childId: string): void {
        this.#budgets.delete(childId);
    }

    noteDeadLetter(letter: DeadLetter): void {
        this.#onDeadLetter?.(letter);
    }

    // Spawn a child actor under this supervisor.
    spawn<State, Msg>(
        fn: ActorFn<State, Msg>,
        options: ActorOptions<State, Msg>
    ): ActorRef<Msg> {
        const child = new Actor(fn, options, this.#scheduler, this);
        this.#children.set(child.id, child);
        return child.ref;
    }

    // Spawn a child supervisor under this supervisor.
    spawnSupervisor(options: Omit<SupervisorOptions, 'scheduler'> = {}): Supervisor {
        const childSupervisor = new Supervisor(this, {
            // Inherited so a nested tree reports dead letters to one place by
            // default, without wiring the hook at every level.
            onDeadLetter: this.#onDeadLetter,
            ...options,
            scheduler: this.#scheduler,
        });
        this.#children.set(childSupervisor.id, childSupervisor);
        return childSupervisor;
    }

    spawnTask<T>(fn: () => T | Promise<T>): Promise<T> {
        const task = new Task(fn, { scheduler: this.#scheduler });
        this.#children.set(task.id, task);
        return task.promise;
    }

    spawnServer<State, Msg extends { type: string }>(options: ServerOptions<State, Msg>): ServerRef<Msg> {
        const server = new Server({ ...options, scheduler: this.#scheduler, crashHandler: this });
        this.#children.set(server.id, server);
        return server.ref;
    }

    spawnAgent<State>(initialState: State, options: AgentOptions = {}): AgentRef<State> {
        const agent = new Agent(initialState, { ...options, scheduler: this.#scheduler, crashHandler: this });
        this.#children.set(agent.id, agent);
        return agent.ref;
    }

    // Stop all children immediately.
    stop(): void {
        for (const [id, child] of this.#children) {
            this.#cancelPendingRestart(id);
            child.stop();
        }
    }

    suspend(): void {
        for (const child of this.#children.values()) {
            child.suspend();
        }
    }

    #cancelPendingRestart(childId: string): void {
        const timer = this.#timers.get(childId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.#timers.delete(childId);
        }
    }

    // Restart after a delay WITHOUT awaiting it. The scheduler drains actors
    // sequentially, and handleCrash is awaited inside drain(), so sleeping here
    // would freeze every other actor sharing the scheduler. Instead the child
    // suspends — it keeps accepting messages but stops draining — and a timer
    // restarts it later.
    #restartAfterBackoff(childId: string, child: Supervisable, restarts: number, opts: RestartOptions): void {
        if (this.#backoff === 'none') {
            child.restart(opts);
            return;
        }

        this.#cancelPendingRestart(childId);
        child.suspend();

        const timer = setTimeout(() => {
            this.#timers.delete(childId);
            child.restart(opts);
        }, this.#delayFor(restarts));

        // A supervisor waiting to restart should not by itself keep the process alive.
        timer.unref?.();
        this.#timers.set(childId, timer);
    }

    #delayFor(restarts: number): number {
        const backoff = this.#backoff;
        if (backoff === 'none') return 0;
        const growth = backoff.initialMs * Math.pow(backoff.factor, Math.max(0, restarts - 1));
        const capped = Math.min(growth, backoff.maxMs);
        // Equal jitter: half fixed, half random.
        return backoff.jitter ? capped / 2 + Math.random() * (capped / 2) : capped;
    }

    // A supervisor holds no state and no mailbox, so it absorbs `state` and forwards
    // only the intent downward. `replay` degrades to `resume` because there is no
    // message here to redeliver.
    restart(opts?: RestartOptions): void {
        const policy = opts?.policy === 'replay' ? 'resume' : opts?.policy;
        for (const child of this.#children.values()) {
            child.restart({ policy });
        }
    }

    #deadLetter(crash: Crash, reason: DeadLetterReason): void {
        this.#onDeadLetter?.({
            childId: crash.childId,
            message: crash.message,
            error: crash.error,
            reason,
        });
    }

    #budgetFor(childId: string): Budget {
        let budget = this.#budgets.get(childId);
        if (!budget) {
            budget = { restarts: 0, lastMessage: undefined, attempts: 0 };
            this.#budgets.set(childId, budget);
        }
        return budget;
    }

    // Apply `fn` to every child in scope. `isCrashed` marks the one child that was
    // actually holding the failed message.
    #eachInScope(crashedId: string, fn: (child: Supervisable, id: string, isCrashed: boolean) => void): void {
        switch (this.#scope) {
            case 'one': {
                const child = this.#children.get(crashedId);
                if (child) fn(child, crashedId, true);
                break;
            }
            case 'all': {
                for (const [id, child] of this.#children) fn(child, id, id === crashedId);
                break;
            }
            case 'rest': {
                // Depends on spawn order — children spawned after the crashed one are
                // assumed to depend on it (OTP's rest_for_one).
                const ids = [...this.#children.keys()];
                const start = ids.indexOf(crashedId);
                if (start === -1) return;
                for (let i = start; i < ids.length; i++) {
                    fn(this.#children.get(ids[i])!, ids[i], ids[i] === crashedId);
                }
                break;
            }
        }
    }

    async handleCrash(crash: Crash): Promise<Directive> {
        if (!this.#children.has(crash.childId)) return 'drop'; // already stopped

        switch (this.#policy) {
            case 'escalate':
                return this.#parent.handleCrash({ ...crash, childId: this.id });

            case 'stop':
                this.#eachInScope(crash.childId, (child, id) => {
                    this.#cancelPendingRestart(id);
                    child.stop();
                });
                this.#deadLetter(crash, 'retired');
                return 'drop';

            case 'reset':
            case 'resume':
            case 'replay': {
                const budget = this.#budgetFor(crash.childId);

                // Restart budget first: a child about to be retired should not replay.
                budget.restarts++;
                if (budget.restarts > this.#maxRestarts) {
                    this.#budgets.delete(crash.childId);
                    this.#eachInScope(crash.childId, (child, id) => {
                        this.#cancelPendingRestart(id); // no reviving a retired child
                        child.stop();
                    });
                    this.#deadLetter(crash, 'retired');
                    return 'drop';
                }

                // Per-message attempts. Identity, not equality: replay pushes the very
                // same reference back, so `===` distinguishes "this message failed
                // again" from "a different message failed". A WeakMap would not work —
                // messages are frequently primitives.
                let replay = this.#policy === 'replay';
                // Anything not replayed is a message that will never be delivered.
                let reason: DeadLetterReason | undefined = replay ? undefined : 'dropped';
                if (replay) {
                    if (budget.lastMessage === crash.message) {
                        budget.attempts++;
                    } else {
                        budget.lastMessage = crash.message;
                        budget.attempts = 1;
                    }
                    if (budget.attempts >= this.#maxAttempts) {
                        // Poison. Drop it and let the child carry on with the rest of
                        // its mailbox rather than retiring the child itself.
                        replay = false;
                        reason = 'poison';
                        budget.lastMessage = undefined;
                        budget.attempts = 0;
                    }
                }

                // Siblings never saw the message, so replay is meaningless for them.
                // They share the crashed child's delay so a scoped restart stays a
                // single coordinated event rather than a stagger.
                const siblingPolicy: Policy = this.#policy === 'replay' ? 'resume' : this.#policy;
                this.#eachInScope(crash.childId, (child, id, isCrashed) => {
                    this.#restartAfterBackoff(id, child, budget.restarts, isCrashed
                        ? { policy: this.#policy, state: crash.previousState }
                        : { policy: siblingPolicy });
                });

                if (reason) this.#deadLetter(crash, reason);
                return replay ? 'replay' : 'drop';
            }

            default:
                return assertUnreachable(this.#policy);
        }
    }
}

let idCounter = 0;
function nextId() {
    return idCounter++;
}

function assertUnreachable(policy: never): never {
    throw new Error(`Unhandled policy: ${policy}`);
}
