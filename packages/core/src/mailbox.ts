import { Queue } from "./queue.js";

// Buffer between senders and the actor's processing loop.
// Messages queue up here and are processed one at a time when
// the scheduler calls drain(). This decouples "sending a message"
// from "processing a message" — senders never block, and messages
// are never lost while the actor is busy. The high watermark
// provides backpressure: when the mailbox is full, push() signals
// the sender to slow down.
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