import { Task } from "../src/task";

describe('Task', () => {
    it('resolves with the result of the task function', async () => {
        const task = new Task(() => 42);
        expect(await task.promise).toBe(42);
    });

    it('resoves with the result of an async task function', async () => {
        const task = new Task(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return 'hello';
        });
        expect(await task.promise).toBe('hello');
    });

    it('rejects if the task function throws an error', async () => {
        const task = new Task(() => { throw new Error('Task failed'); });
        await expect(task.promise).rejects.toThrow('Task failed');
    });

    it('rejects if the task function returns a rejected promise', async () => {
        const task = new Task(() => Promise.reject(new Error('Async failure')));
        await expect(task.promise).rejects.toThrow('Async failure');
    });

    it('can be stopped before it runs', async () => {
        const task = new Task(() => 42);
        task.stop();
        await expect(task.promise).rejects.toThrow(/stopped/);
    });

    it('can be stopped while running', async () => {
        const task = new Task(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return 42;
        });
        setTimeout(() => task.stop(), 10);
        await expect(task.promise).rejects.toThrow(/stopped/);
    });
});