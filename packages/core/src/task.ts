import { DEFAULT_SCHEDULER, Scheduler } from "./scheduler.js";
import { Drainable, Supervisable } from "./types.js";

let _nextId = 0;
function nextId(): string {
    return `task-${_nextId++}`;
}

interface TaskOptions {
    scheduler?: Scheduler;
    id?: string;
}

export class Task<T> implements Drainable, Supervisable {
    readonly id: string;
    #stopped = false;
    readonly #fn: () => T | Promise<T>;
    readonly #scheduler: Scheduler;
    #promise?: Promise<T>;
    #resolve?: (value: T) => void;
    #reject?: (reason: unknown) => void

    constructor(
        fn: () => T | Promise<T>,
        {
            scheduler = DEFAULT_SCHEDULER,
            id = nextId()
        }: TaskOptions = {}
    ) {
        this.id = id;
        this.#fn = fn;
        this.#scheduler = scheduler;
        this.#promise = new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        });
        this.#scheduler.enqueue(this);
    }


    get promise(): Promise<T> {
        return this.#promise!;
    }

    async drain(): Promise<boolean> {
        if (this.#stopped) {
            this.#reject?.(new Error(`Task ${this.id} is stopped`));
            return false;
        }

        try {
            const result = await this.#fn();
            this.#resolve?.(result);
        } catch (error) {
            this.#reject?.(error);
        }
        return false;
    }

    stop(): void {
        this.#stopped = true;
        this.#reject?.(new Error(`Task ${this.id} was stopped`));
    }

    restart(): void {
        // Task is temporary — restart is a no-op or throws
    }
}
