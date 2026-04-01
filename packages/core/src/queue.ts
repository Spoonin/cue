export class Queue<T> {
  #buf: (T | undefined)[];
  #head = 0;
  #tail = 0;
  #size = 0;
  #cap;

  constructor(capacity = 256) {
    this.#cap = capacity;
    this.#buf = new Array(capacity);
  }

  enqueue(item: T) {
    if (this.#size === this.#cap) this.#grow();
    this.#buf[this.#tail] = item;
    this.#tail = (this.#tail + 1) % this.#cap;
    this.#size++;
  }

  dequeue(): T | undefined {
    if (this.#size === 0) return undefined;
    const item = this.#buf[this.#head];
    this.#buf[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#cap;
    this.#size--;
    return item;
  }

  // Push to the front — used by Supervisor.replayLast to re-enqueue a failed message.
  prepend(item: T) {
    if (this.#size === this.#cap) this.#grow();
    this.#head = (this.#head - 1 + this.#cap) % this.#cap;
    this.#buf[this.#head] = item;
    this.#size++;
  }

  peek(): T | undefined { return this.#size === 0 ? undefined : this.#buf[this.#head]; }
  isEmpty(): boolean { return this.#size === 0; }
  size(): number { return this.#size; }

  #grow() {
    const next = this.#cap * 2;
    let   buf: (T | undefined)[];
    if (this.#head < this.#tail) {
      // contiguous — one native slice, no per-element work
      buf = this.#buf.slice(this.#head, this.#tail);
      buf.length = next;
    } else {
      // wrapped — two straight segments, no modulo
      buf = new Array(next);
      let k = 0;
      for (let i = this.#head; i < this.#cap; i++) buf[k++] = this.#buf[i];
      for (let i = 0;          i < this.#tail; i++) buf[k++] = this.#buf[i];
    }
    this.#head = 0;
    this.#tail = this.#size;
    this.#cap  = next;
    this.#buf  = buf;
  }
}