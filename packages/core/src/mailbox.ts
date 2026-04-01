import { Queue } from "./queue.js";

export class Mailbox<T> {
    #highWatermark: number;
    #queue: Queue<T> = new Queue();
    
    constructor(highWatermark: number = Infinity) {
        this.#highWatermark = highWatermark;
    }

    push(item: T) {
        this.#queue.enqueue(item);
        if (this.#queue.size() > this.#highWatermark) {
            return false;
        }
        return true;
    }

    tryPush(item: T): boolean {
        if (this.#queue.size() >= this.#highWatermark) {
            return false;
        }
        this.#queue.enqueue(item);
        return true;
    }

    pull(): T | undefined {
        return this.#queue.dequeue();
    }

    // Push to the front — used by Supervisor to replay a failed message.
    pushFront(item: T): void {
        this.#queue.prepend(item);
    }

    clear(): void {
        this.#queue = new Queue();
    }

    get count(): number {
        return this.#queue.size();
    }

    get isEmpty(): boolean {
        return this.#queue.isEmpty();
    }
}