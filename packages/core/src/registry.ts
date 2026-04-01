import { ActorRef } from "./types.js";

// Phase 1: simple in-process name → ref map.
// Phase 4: needs to work across worker threads — SharedArrayBuffer + Atomics.

// TMap defines the named actors and their message types:
// type MyActors = {
//     'counter': { type: 'increment' } | { type: 'decrement' }
//     'logger':  { level: 'info' | 'error'; msg: string }
// }
// const registry = new Registry<MyActors>()
// registry.lookup('counter')  // → ActorRef<{ type: 'increment' } | { type: 'decrement' }>

export class Registry<TMap extends Record<string, unknown> = Record<string, unknown>> {
    #store: Map<string, WeakRef<ActorRef<unknown>>> = new Map();
    #finalizer = new FinalizationRegistry((name: string) => {
        console.info(`actor '${name}' was garbage collected`);
        this.#store.delete(name);
    });

    // Register an actor under a name.
    // Returns false if the name is already taken.
    register<K extends keyof TMap & string>(name: K, ref: ActorRef<TMap[K]>): boolean {
        if (this.#store.has(name) && this.#store.get(name)?.deref() !== undefined) {
            return false;
        }
        this.#store.set(name, new WeakRef(ref));
        this.#finalizer.register(ref, name);
        return true;
    }

    // Look up an actor by name.
    // Returns undefined if not found or actor was GC'd (Phase 2: WeakRef).
    lookup<K extends keyof TMap & string>(name: K): ActorRef<TMap[K]> | undefined {
        return this.#store.get(name)?.deref() as ActorRef<TMap[K]> | undefined;
    }

    // Remove a name from the registry.
    unregister<K extends keyof TMap & string>(name: K): void {
        this.#store.delete(name);
    }

    // For debugging: how many entries are in the registry (including GC'd ones).
    get size(): number {
        return this.#store.size;
    }
}
