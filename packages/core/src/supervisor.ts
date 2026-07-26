import { Actor } from "./actor.js";
import { DEFAULT_SCHEDULER, Scheduler } from "./scheduler.js";
import { Task } from "./task.js";
import { Server, ServerOptions } from "./server.js";
import { ActorFn, ActorOptions, ActorRef, Crash, CrashHandler, Directive, ErrorReporter, Policy, RestartOptions, Scope, Supervisable, ServerRef, AgentRef } from "./types.js";
import { Agent, AgentOptions } from "./agent.js";

interface SupervisorOptions {
    scope?: Scope;
    policy?: Policy;
    id?: string;
    scheduler?: Scheduler;
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

    constructor(
        parent: CrashHandler | ErrorReporter,
        { scope = 'one', policy = 'reset', id = `supervisor-${nextId()}`, scheduler = DEFAULT_SCHEDULER }: SupervisorOptions = {}
    ) {
        if (!parent) {
            throw new Error("Supervisor missing a parent CrashHandler or ErrorReporter");
        }
        this.id = id;
        this.#scheduler = scheduler;
        this.#scope = scope;
        this.#policy = policy;
        this.#parent = asCrashHandler(parent);
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
        const childSupervisor = new Supervisor(this, { ...options, scheduler: this.#scheduler });
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
        for (const child of this.#children.values()) {
            child.stop();
        }
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

    // Apply `fn` to every child in scope. `isCrashed` marks the one child that was
    // actually holding the failed message.
    #eachInScope(crashedId: string, fn: (child: Supervisable, isCrashed: boolean) => void): void {
        switch (this.#scope) {
            case 'one': {
                const child = this.#children.get(crashedId);
                if (child) fn(child, true);
                break;
            }
            case 'all': {
                for (const [id, child] of this.#children) fn(child, id === crashedId);
                break;
            }
            case 'rest': {
                // Depends on spawn order — children spawned after the crashed one are
                // assumed to depend on it (OTP's rest_for_one).
                const ids = [...this.#children.keys()];
                const start = ids.indexOf(crashedId);
                if (start === -1) return;
                for (let i = start; i < ids.length; i++) {
                    fn(this.#children.get(ids[i])!, ids[i] === crashedId);
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
                this.#eachInScope(crash.childId, (child) => child.stop());
                return 'drop';

            case 'reset':
            case 'resume':
            case 'replay': {
                // Siblings never saw the message, so replay is meaningless for them.
                const siblingPolicy: Policy = this.#policy === 'replay' ? 'resume' : this.#policy;
                this.#eachInScope(crash.childId, (child, isCrashed) => {
                    child.restart(isCrashed
                        ? { policy: this.#policy, state: crash.previousState }
                        : { policy: siblingPolicy });
                });
                return this.#policy === 'replay' ? 'replay' : 'drop';
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
