import { Actor, defaultScheduler } from "./actor.js";
import { Scheduler } from "./scheduler.js";
import { ActorFn, ActorOptions, ActorRef, CrashHandler, Supervisable, SupervisionStrategy } from "./types.js";

interface SupervisorOptions {
    strategy?: SupervisionStrategy;
    id?: string;
    scheduler?: Scheduler;
}

export class Supervisor implements CrashHandler, Supervisable {
    readonly #scheduler: Scheduler;
    readonly #strategy: SupervisionStrategy;
    readonly id: string;
    readonly #crashHandler: CrashHandler;
    readonly #children: Map<string, Supervisable> = new Map();

    constructor(crashHandler: CrashHandler, { strategy = 'restartOne', id = `supervisor-${nextId()}`, scheduler = defaultScheduler }: SupervisorOptions = {}) {
        this.id = id;
        this.#scheduler = scheduler;
        this.#strategy = strategy;
        if(!crashHandler) {
            throw new Error("Supervisor missing a CrashHandler dependency instance");
        }
        this.#crashHandler = crashHandler;
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
    spawnSupervisor(strategy: SupervisionStrategy): Supervisor {
        const childSupervisor = new Supervisor(this, { strategy, scheduler: this.#scheduler });
        this.#children.set(childSupervisor.id, childSupervisor);
        return childSupervisor;
    }

    // Stop all children immediately.
    stop(): void {
        for (const child of this.#children.values()) {
            child.stop();
        }
    }

    restart(): void {
        for (const child of this.#children.values()) {
            child.restart();
        }
    }

    async #onCrash(childId: string, err: unknown, msg: unknown, prevState: unknown): Promise<void> {
        const child = this.#children.get(childId);
        if (!child) return; // already stopped

        switch (this.#strategy) {
            case 'restartOne':
                child.restart();
                break;
            case 'restartAll':
                this.restart();
                break;
            case 'restartRest': {
                const ids = [...this.#children.keys()];
                const startIdx = ids.indexOf(childId);
                for (let i = startIdx; i < ids.length; i++) {
                    this.#children.get(ids[i])!.restart();
                }
                break;
            }
            case 'escalate': {
                await this.#crashHandler.handleCrash(this.id, err, msg, prevState);
                break;
            }
            default: assertUnreachable(this.#strategy);
        }
    }

    async handleCrash(id: string, err: unknown, msg: unknown, prevState: unknown): Promise<void> {
        await this.#onCrash(id, err, msg, prevState);
    }
}

let idCounter = 0;
function nextId() {
    return idCounter++;
}

function assertUnreachable(strategy: never) {
    throw new Error(`Unhandled strategy: ${strategy}`);
}

