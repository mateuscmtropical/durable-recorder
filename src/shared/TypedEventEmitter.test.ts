import { describe, it, expect, vi, afterEach } from 'vitest';
import { TypedEventEmitter } from './TypedEventEmitter';

interface TestEventMap {
    ready: string;
    count: number;
}

function createCallRecorder(calls: string[], name: string): () => void {
    return () => {
        calls.push(name);
    };
}

function captureMicrotasks(): VoidFunction[] {
    const queuedTasks: VoidFunction[] = [];

    vi.spyOn(globalThis, 'queueMicrotask')
        .mockImplementation((task: VoidFunction) => {
            queuedTasks.push(task);
        });

    return queuedTasks;
}

describe('TypedEventEmitter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('on', () => {
        it('passes the payload to the listener', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            emitter.on('count', listener);
            emitter.emit('count', 3);

            expect(listener)
                .toHaveBeenCalledWith(3);
        });

        it('runs listeners synchronously in the order they were added', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const calls: string[] = [];

            emitter.on('count', createCallRecorder(calls, 'first'));
            emitter.on('count', createCallRecorder(calls, 'second'));
            emitter.on('count', createCallRecorder(calls, 'third'));
            emitter.emit('count', 1);

            expect(calls)
                .toEqual(['first', 'second', 'third']);
        });

        it('registers the same listener only once when it is added twice', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            emitter.on('count', listener);
            emitter.on('count', listener);
            emitter.emit('count', 1);

            expect(listener)
                .toHaveBeenCalledTimes(1);
            expect(emitter.listenerCount('count'))
                .toBe(1);
        });

        it('returns a function that removes the listener', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            const removeListener = emitter.on('count', listener);

            removeListener();
            emitter.emit('count', 1);

            expect(listener).not.toHaveBeenCalled();
            expect(emitter.listenerCount('count'))
                .toBe(0);
        });

        it('does not call listeners of one event when another event is emitted', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const readyListener = vi.fn();

            emitter.on('ready', readyListener);
            emitter.emit('count', 1);

            expect(readyListener).not.toHaveBeenCalled();
        });
    });

    describe('once', () => {
        it('runs the listener only on the first emit', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            emitter.once('count', listener);
            emitter.emit('count', 1);
            emitter.emit('count', 2);

            expect(listener)
                .toHaveBeenCalledTimes(1);
            expect(listener)
                .toHaveBeenCalledWith(1);
        });

        it('removes the listener before it runs', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const countsInsideListener: number[] = [];

            emitter.once('count', () => {
                countsInsideListener.push(emitter.listenerCount('count'));
            });
            emitter.emit('count', 1);

            expect(countsInsideListener)
                .toEqual([0]);
        });

        it('removes the once listener even when it throws', () => {
            const queuedTasks = captureMicrotasks();
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn(() => {
                throw new Error('listener failed');
            });

            emitter.once('count', listener);
            emitter.emit('count', 1);
            emitter.emit('count', 2);

            expect(listener)
                .toHaveBeenCalledTimes(1);
            expect(queuedTasks)
                .toHaveLength(1);
        });

        it('returns a function that cancels the listener before emit', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            const cancelListener = emitter.once('count', listener);

            cancelListener();
            emitter.emit('count', 1);

            expect(listener).not.toHaveBeenCalled();
        });

        it('removes a once listener when off is called with the same function', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            emitter.once('count', listener);
            emitter.off('count', listener);
            emitter.emit('count', 1);

            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('off', () => {
        it('removes the listener so it no longer runs', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            emitter.on('count', listener);
            emitter.off('count', listener);
            emitter.emit('count', 1);

            expect(listener).not.toHaveBeenCalled();
        });

        it('leaves the other listeners of the event in place', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const removedListener = vi.fn();
            const keptListener = vi.fn();

            emitter.on('count', removedListener);
            emitter.on('count', keptListener);
            emitter.off('count', removedListener);
            emitter.emit('count', 1);

            expect(removedListener).not.toHaveBeenCalled();
            expect(keptListener)
                .toHaveBeenCalledTimes(1);
        });

        it('does nothing when the listener was never added', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();

            expect(() => {
                emitter.off('count', vi.fn());
            }).not.toThrow();
        });
    });

    describe('emit', () => {
        it('does nothing when the event has no listeners', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();

            expect(() => {
                emitter.emit('count', 1);
            }).not.toThrow();
        });

        it('still runs the other listeners when one removes a listener during emit', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const second = vi.fn();
            const third = vi.fn();
            const first = vi.fn(() => {
                emitter.off('count', second);
            });

            emitter.on('count', first);
            emitter.on('count', second);
            emitter.on('count', third);
            emitter.emit('count', 1);

            expect(second)
                .toHaveBeenCalledTimes(1);
            expect(third)
                .toHaveBeenCalledTimes(1);

            emitter.emit('count', 2);

            expect(second)
                .toHaveBeenCalledTimes(1);
            expect(third)
                .toHaveBeenCalledTimes(2);
        });

        it('does not run a listener added during emit until the next emit', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const lateListener = vi.fn();

            emitter.on('count', () => {
                emitter.on('count', lateListener);
            });
            emitter.emit('count', 1);

            expect(lateListener).not.toHaveBeenCalled();

            emitter.emit('count', 2);

            expect(lateListener)
                .toHaveBeenCalledTimes(1);
        });

        it('keeps calling the other listeners when one throws', () => {
            captureMicrotasks();
            const emitter = new TypedEventEmitter<TestEventMap>();
            const before = vi.fn();
            const after = vi.fn();

            emitter.on('count', before);
            emitter.on('count', () => {
                throw new Error('listener failed');
            });
            emitter.on('count', after);

            expect(() => {
                emitter.emit('count', 1);
            }).not.toThrow();
            expect(before)
                .toHaveBeenCalledTimes(1);
            expect(after)
                .toHaveBeenCalledTimes(1);
        });

        it('rethrows the listener error asynchronously with queueMicrotask', () => {
            const queuedTasks = captureMicrotasks();
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listenerError = new Error('listener failed');

            emitter.on('count', () => {
                throw listenerError;
            });
            emitter.emit('count', 1);

            expect(queuedTasks)
                .toHaveLength(1);

            const [rethrowTask] = queuedTasks;
            let rethrown: unknown;

            try {
                rethrowTask?.();
            } catch (error: unknown) {
                rethrown = error;
            }

            expect(rethrown)
                .toBe(listenerError);
        });

        it('queues one rethrow for each listener that throws', () => {
            const queuedTasks = captureMicrotasks();
            const emitter = new TypedEventEmitter<TestEventMap>();

            emitter.on('count', () => {
                throw new Error('first failure');
            });
            emitter.on('count', () => {
                throw new Error('second failure');
            });
            emitter.emit('count', 1);

            expect(queuedTasks)
                .toHaveLength(2);
        });

        it('rejects a payload whose type does not match the event map', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const listener = vi.fn();

            emitter.on('count', listener);
            // @ts-expect-error count expects a number, not a string
            emitter.emit('count', 'three');

            expect(listener)
                .toHaveBeenCalledTimes(1);
        });
    });

    describe('removeAllListeners', () => {
        it('removes every listener of every event', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();
            const readyListener = vi.fn();
            const countListener = vi.fn();

            emitter.on('ready', readyListener);
            emitter.on('count', countListener);
            emitter.removeAllListeners();
            emitter.emit('ready', 'id');
            emitter.emit('count', 1);

            expect(readyListener).not.toHaveBeenCalled();
            expect(countListener).not.toHaveBeenCalled();
            expect(emitter.listenerCount('ready'))
                .toBe(0);
            expect(emitter.listenerCount('count'))
                .toBe(0);
        });
    });

    describe('listenerCount', () => {
        it('returns 0 for an event without listeners', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();

            expect(emitter.listenerCount('ready'))
                .toBe(0);
        });

        it('counts the listeners of one event only', () => {
            const emitter = new TypedEventEmitter<TestEventMap>();

            emitter.on('count', vi.fn());
            emitter.on('count', vi.fn());
            emitter.on('ready', vi.fn());

            expect(emitter.listenerCount('count'))
                .toBe(2);
            expect(emitter.listenerCount('ready'))
                .toBe(1);
        });
    });
});
