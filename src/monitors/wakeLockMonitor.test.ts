import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { createWakeLockMonitor } from './wakeLockMonitor';
import type { MonitorContext, MonitorProblemCode, RecordingMonitor } from './RecordingMonitor';
import { asMediaStream, createFakeStream, createFakeTrack } from '../../test/helpers/fakeTrack';

// The wake lock monitor has no timers, so these tests use real timers. A
// rejected promise that nothing handles fails the run as an unhandled error,
// and flushMacrotask() gives Node a turn to report it.

class FakeWakeLockSentinel extends EventTarget {
    readonly type = 'screen';
    released = false;
    releaseCallCount = 0;
    releaseError: Error | null = null;

    release(): Promise<void> {
        this.releaseCallCount += 1;
        this.markReleased();

        if (this.releaseError) {
            return Promise.reject(this.releaseError);
        }

        return Promise.resolve();
    }

    // Like a browser, the system drops the lock (for example when the page is hidden).
    dropBySystem(): void {
        this.markReleased();
    }

    private markReleased(): void {
        if (this.released) {
            return;
        }

        this.released = true;
        this.dispatchEvent(new Event('release'));
    }
}

type WakeLockRequest = (type: 'screen') => Promise<FakeWakeLockSentinel>;

interface WakeLockFixture {
    request: Mock<WakeLockRequest>;
    sentinels: FakeWakeLockSentinel[];
}

interface MonitorHarness {
    monitor: RecordingMonitor;
    reportedProblems: MonitorProblemCode[];
}

interface PendingRequest {
    resolve: (sentinel: FakeWakeLockSentinel) => void;
}

function setVisibility(visibilityState: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState,
    });
}

function fireVisibilityChange(visibilityState: 'visible' | 'hidden'): void {
    setVisibility(visibilityState);
    document.dispatchEvent(new Event('visibilitychange'));
}

function grantNewSentinel(sentinels: FakeWakeLockSentinel[]): Promise<FakeWakeLockSentinel> {
    const sentinel = new FakeWakeLockSentinel();

    sentinels.push(sentinel);

    return Promise.resolve(sentinel);
}

function stubWakeLockApi(): WakeLockFixture {
    const sentinels: FakeWakeLockSentinel[] = [];
    const request = vi.fn<WakeLockRequest>(() => grantNewSentinel(sentinels));

    vi.stubGlobal('navigator', { wakeLock: { request } });

    return { request, sentinels };
}

// The next request stays pending until the test resolves it.
function holdNextRequest(request: Mock<WakeLockRequest>): PendingRequest {
    const pending: PendingRequest = { resolve: () => undefined };

    request.mockImplementationOnce(() => new Promise<FakeWakeLockSentinel>((resolve) => {
        pending.resolve = resolve;
    }));

    return pending;
}

function startMonitor(): MonitorHarness {
    const reportedProblems: MonitorProblemCode[] = [];
    const context: MonitorContext = {
        stream: asMediaStream(createFakeStream(createFakeTrack())),
        reportProblem: (code) => {
            reportedProblems.push(code);
        },
        warnSilence: vi.fn(),
    };
    const createMonitor = createWakeLockMonitor();
    const monitor = createMonitor(context);

    return { monitor, reportedProblems };
}

async function flushMacrotask(): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('createWakeLockMonitor', () => {
    beforeEach(() => {
        setVisibility('visible');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(document, 'visibilityState');
    });

    describe('on creation', () => {
        it('requests a screen lock when the API exists and the page is visible', () => {
            const fixture = stubWakeLockApi();

            startMonitor();

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
            expect(fixture.request)
                .toHaveBeenCalledWith('screen');
        });

        it('waits for the page to be visible before requesting the lock', async () => {
            setVisibility('hidden');
            const fixture = stubWakeLockApi();

            startMonitor();
            await flushMacrotask();

            expect(fixture.request).not.toHaveBeenCalled();

            fireVisibilityChange('visible');

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
        });

        it('does nothing and reports nothing when navigator.wakeLock is missing', () => {
            vi.stubGlobal('navigator', {});

            const harness = startMonitor();

            expect(() => {
                harness.monitor.release();
            }).not.toThrow();
            expect(harness.reportedProblems)
                .toEqual([]);
        });
    });

    describe('visibility changes', () => {
        it('requests the lock again when the page becomes visible and the lock was dropped', async () => {
            const fixture = stubWakeLockApi();

            startMonitor();
            await flushMacrotask();

            const [firstSentinel] = fixture.sentinels;

            fireVisibilityChange('hidden');
            firstSentinel?.dropBySystem();
            fireVisibilityChange('visible');
            await flushMacrotask();

            expect(fixture.request)
                .toHaveBeenCalledTimes(2);
            expect(fixture.request)
                .toHaveBeenLastCalledWith('screen');
        });

        it('does not request again when the lock is still held and the page becomes visible', async () => {
            const fixture = stubWakeLockApi();

            startMonitor();
            await flushMacrotask();

            fireVisibilityChange('visible');
            await flushMacrotask();

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
        });

        it('does not request when the page becomes hidden', async () => {
            const fixture = stubWakeLockApi();

            startMonitor();
            await flushMacrotask();

            fireVisibilityChange('hidden');
            await flushMacrotask();

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
        });

        it('does not request twice while a request is still pending', () => {
            const fixture = stubWakeLockApi();

            holdNextRequest(fixture.request);
            startMonitor();
            fireVisibilityChange('hidden');
            fireVisibilityChange('visible');
            fireVisibilityChange('visible');

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
        });

        it('does not request after release() even when the page becomes visible', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();
            harness.monitor.release();
            fireVisibilityChange('hidden');
            fireVisibilityChange('visible');
            await flushMacrotask();

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
        });
    });

    describe('pause and resume', () => {
        it('releases the lock on pause', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();
            harness.monitor.pause();

            const [firstSentinel] = fixture.sentinels;

            expect(firstSentinel?.releaseCallCount)
                .toBe(1);
            expect(firstSentinel?.released)
                .toBe(true);
        });

        it('requests the lock again on resume', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();
            harness.monitor.pause();
            harness.monitor.resume();

            expect(fixture.request)
                .toHaveBeenCalledTimes(2);
            expect(fixture.request)
                .toHaveBeenLastCalledWith('screen');
        });

        it('does not request the lock when the page becomes visible while paused', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();
            harness.monitor.pause();
            fireVisibilityChange('hidden');
            fireVisibilityChange('visible');
            await flushMacrotask();

            expect(fixture.request)
                .toHaveBeenCalledTimes(1);
        });

        it('releases a lock that resolves after pause()', async () => {
            const fixture = stubWakeLockApi();
            const pending = holdNextRequest(fixture.request);
            const harness = startMonitor();
            const lateSentinel = new FakeWakeLockSentinel();

            harness.monitor.pause();
            pending.resolve(lateSentinel);
            await flushMacrotask();

            expect(lateSentinel.releaseCallCount)
                .toBe(1);
        });

        it('pause() does nothing when no lock is held', () => {
            vi.stubGlobal('navigator', {});
            const harness = startMonitor();

            expect(() => {
                harness.monitor.pause();
            }).not.toThrow();
            expect(harness.reportedProblems)
                .toEqual([]);
        });
    });

    describe('release', () => {
        it('releases the lock and removes the visibilitychange listener', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();
            const removeListenerSpy = vi.spyOn(document, 'removeEventListener');

            await flushMacrotask();
            harness.monitor.release();

            const [firstSentinel] = fixture.sentinels;

            expect(firstSentinel?.releaseCallCount)
                .toBe(1);
            expect(removeListenerSpy)
                .toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        });

        it('releases a lock that resolves after release()', async () => {
            const fixture = stubWakeLockApi();
            const pending = holdNextRequest(fixture.request);
            const harness = startMonitor();
            const lateSentinel = new FakeWakeLockSentinel();

            harness.monitor.release();
            pending.resolve(lateSentinel);
            await flushMacrotask();

            expect(lateSentinel.releaseCallCount)
                .toBe(1);
            expect(lateSentinel.released)
                .toBe(true);
        });

        it('can be called twice without throwing', async () => {
            stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();
            harness.monitor.release();

            expect(() => {
                harness.monitor.release();
            }).not.toThrow();
        });
    });

    describe('errors are ignored and never reported', () => {
        it('does not report a problem when request() rejects', async () => {
            const fixture = stubWakeLockApi();

            fixture.request.mockImplementationOnce(() => Promise.reject(new DOMException('Denied.', 'NotAllowedError')));
            const harness = startMonitor();

            await flushMacrotask();

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('ignores a request that rejects on visibility change', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();
            fixture.request.mockImplementationOnce(() => Promise.reject(new DOMException('Busy.', 'NotReadableError')));
            fireVisibilityChange('hidden');
            fireVisibilityChange('visible');
            await flushMacrotask();

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('ignores a release() that rejects on pause', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();

            const [firstSentinel] = fixture.sentinels;

            if (firstSentinel) {
                firstSentinel.releaseError = new Error('release failed');
            }

            harness.monitor.pause();
            await flushMacrotask();

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('ignores a release() that rejects on release()', async () => {
            const fixture = stubWakeLockApi();
            const harness = startMonitor();

            await flushMacrotask();

            const [firstSentinel] = fixture.sentinels;

            if (firstSentinel) {
                firstSentinel.releaseError = new Error('release failed');
            }

            harness.monitor.release();
            await flushMacrotask();

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('never reports a problem across the whole lifecycle', async () => {
            const fixture = stubWakeLockApi();

            fixture.request.mockImplementationOnce(() => Promise.reject(new DOMException('Denied.', 'NotAllowedError')));
            const harness = startMonitor();

            await flushMacrotask();
            fireVisibilityChange('hidden');
            fireVisibilityChange('visible');
            harness.monitor.pause();
            harness.monitor.resume();
            harness.monitor.release();
            await flushMacrotask();

            expect(harness.reportedProblems)
                .toEqual([]);
        });
    });
});
