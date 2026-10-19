import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSilenceMonitor } from './silenceMonitor';
import type { SilenceMonitorOptions } from './silenceMonitor';
import type { MonitorContext, MonitorProblemCode, RecordingMonitor } from './RecordingMonitor';
import { asMediaStream, createFakeStream, createFakeTrack } from '../../test/helpers/fakeTrack';
import type { FakeMediaStreamTrack } from '../../test/helpers/fakeTrack';
import { asAudioContext, createFakeAudioContext } from '../../test/helpers/fakeAudioContext';
import type { FakeAudioContext } from '../../test/helpers/fakeAudioContext';

const CHECK_MS = 250;
const WARNING_MS = 5000;
const LIMIT_MS = 20000;

// Seconds shown by the countdown when the limit is 20 seconds and the warning
// starts after 5 seconds: 15, 14, ..., 1.
const FULL_COUNTDOWN = Array.from({ length: 15 }, (_, index) => 15 - index);

interface Reporter {
    context: MonitorContext;
    reportedProblems: MonitorProblemCode[];
    warnings: number[];
}

interface SilenceHarness {
    monitor: RecordingMonitor;
    audioContext: FakeAudioContext;
    createAudioContext: ReturnType<typeof vi.fn<() => AudioContext>>;
    reportedProblems: MonitorProblemCode[];
    warnings: number[];
}

function createReporter(tracks: FakeMediaStreamTrack[] = [createFakeTrack({ kind: 'audio' })]): Reporter {
    const reportedProblems: MonitorProblemCode[] = [];
    const warnings: number[] = [];
    const stream = createFakeStream(...tracks);
    const context: MonitorContext = {
        stream: asMediaStream(stream),
        reportProblem: (code) => {
            reportedProblems.push(code);
        },
        warnSilence: (secondsLeft) => {
            warnings.push(secondsLeft);
        },
    };

    return { context, reportedProblems, warnings };
}

// Monitors from createHarness are released after each test. Otherwise their
// visibilitychange listeners would run in later tests.
const harnessMonitors: RecordingMonitor[] = [];

function createHarness(options: SilenceMonitorOptions = {}, tracks?: FakeMediaStreamTrack[]): SilenceHarness {
    const audioContext = createFakeAudioContext();
    const createAudioContext = vi.fn(() => asAudioContext(audioContext));
    const reporter = createReporter(tracks);
    const createMonitor = createSilenceMonitor({ createAudioContext, ...options });
    const monitor = createMonitor(reporter.context);

    harnessMonitors.push(monitor);

    return {
        monitor,
        audioContext,
        createAudioContext,
        reportedProblems: reporter.reportedProblems,
        warnings: reporter.warnings,
    };
}

// One loud sample in an otherwise silent buffer. Its RMS is far below its peak.
function createSpikeSamples(length: number): number[] {
    return Array.from({ length }, (_, index) => (index === 0 ? 1 : 0));
}

function setVisibilityAndNotify(visibilityState: DocumentVisibilityState): void {
    vi.spyOn(document, 'visibilityState', 'get')
        .mockReturnValue(visibilityState);
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

// Unhandled rejections are reported once the current task ends. Fake timers
// never fire the wait, so this switches to real timers first.
async function waitForUnhandledRejections(): Promise<void> {
    vi.useRealTimers();
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('createSilenceMonitor', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        const monitors = harnessMonitors.splice(0);

        monitors.forEach((monitor) => {
            monitor.release();
        });

        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    describe('when silence cannot be measured', () => {
        it('does nothing when the stream has no audio track', () => {
            const harness = createHarness({}, [createFakeTrack({ kind: 'video' })]);

            vi.advanceTimersByTime(LIMIT_MS + 10000);

            expect(harness.reportedProblems)
                .toEqual([]);
            expect(harness.warnings)
                .toEqual([]);
            expect(harness.createAudioContext).not.toHaveBeenCalled();
        });

        it('does nothing when no AudioContext is available', () => {
            const reporter = createReporter();
            const createAudioContext = vi.fn(() => null);
            const monitor = createSilenceMonitor({ createAudioContext })(reporter.context);

            vi.advanceTimersByTime(LIMIT_MS + 10000);

            expect(reporter.reportedProblems)
                .toEqual([]);
            expect(reporter.warnings)
                .toEqual([]);
            expect(() => {
                monitor.release();
            }).not.toThrow();
        });

        it('does nothing when the stream cannot be connected to an analyser', () => {
            const audioContext = createFakeAudioContext();
            const reporter = createReporter();

            vi.spyOn(audioContext, 'createMediaStreamSource')
                .mockImplementation(() => {
                    throw new Error('Cannot connect the stream');
                });

            const createMonitor = createSilenceMonitor({ createAudioContext: () => asAudioContext(audioContext) });

            expect(() => createMonitor(reporter.context)).not.toThrow();

            vi.advanceTimersByTime(LIMIT_MS + 10000);

            expect(reporter.reportedProblems)
                .toEqual([]);
            expect(reporter.warnings)
                .toEqual([]);
        });

        it('does nothing with the default factory when the browser has no AudioContext', () => {
            vi.stubGlobal('AudioContext', undefined);
            vi.stubGlobal('webkitAudioContext', undefined);

            const reporter = createReporter();

            createSilenceMonitor()(reporter.context);
            vi.advanceTimersByTime(LIMIT_MS + 10000);

            expect(reporter.reportedProblems)
                .toEqual([]);
            expect(reporter.warnings)
                .toEqual([]);
        });
    });

    describe('default AudioContext', () => {
        it('uses window.AudioContext when no factory is given', () => {
            const audioContext = createFakeAudioContext();

            function fakeAudioContextConstructor(): AudioContext {
                return asAudioContext(audioContext);
            }

            vi.stubGlobal('AudioContext', fakeAudioContextConstructor);

            const reporter = createReporter();

            createSilenceMonitor()(reporter.context);
            vi.advanceTimersByTime(LIMIT_MS + 1000);

            expect(reporter.reportedProblems)
                .toEqual(['SILENCE']);
        });
    });

    describe('measuring', () => {
        it('connects the stream to an analyser', () => {
            const harness = createHarness();
            const [source] = harness.audioContext.sources;

            expect(harness.createAudioContext)
                .toHaveBeenCalledTimes(1);
            expect(source?.connections)
                .toEqual([harness.audioContext.analyser]);
        });

        it('counts a level below rmsThreshold as silence', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0.00005);
            vi.advanceTimersByTime(LIMIT_MS + 1000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });

        it('counts a level above rmsThreshold as sound', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0.001);
            vi.advanceTimersByTime(LIMIT_MS * 2);

            expect(harness.reportedProblems)
                .toEqual([]);
            expect(harness.warnings)
                .toEqual([]);
        });

        it('uses rmsThreshold from the options', () => {
            const harness = createHarness({ rmsThreshold: 0.05 });

            harness.audioContext.analyser.setLevel(0.01);
            vi.advanceTimersByTime(LIMIT_MS + 1000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });

        it('measures the RMS of the samples, not their peak', () => {
            const harness = createHarness({ rmsThreshold: 0.05 });
            const analyser = harness.audioContext.analyser;

            analyser.setSamples(createSpikeSamples(analyser.fftSize));
            vi.advanceTimersByTime(LIMIT_MS + 1000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });
    });

    describe('warnings and the limit', () => {
        it('stays quiet during the first warningMs of silence', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(WARNING_MS - CHECK_MS);

            expect(harness.warnings)
                .toEqual([]);
            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('counts down once a second, sending each value once', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(LIMIT_MS - 1);

            expect(harness.warnings)
                .toEqual(FULL_COUNTDOWN);
        });

        it('reports SILENCE at the limit, once', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(LIMIT_MS - CHECK_MS);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(CHECK_MS * 2);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);

            vi.advanceTimersByTime(LIMIT_MS);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });

        it('clears the warning with 0 once when sound returns', () => {
            const harness = createHarness();
            const analyser = harness.audioContext.analyser;

            analyser.setLevel(0);
            vi.advanceTimersByTime(7500);

            expect(harness.warnings)
                .toEqual([15, 14, 13]);

            analyser.setLevel(0.5);
            vi.advanceTimersByTime(2000);

            expect(harness.warnings)
                .toEqual([15, 14, 13, 0]);

            vi.advanceTimersByTime(10000);

            expect(harness.warnings)
                .toEqual([15, 14, 13, 0]);
            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('starts the countdown again when silence returns after sound', () => {
            const harness = createHarness();
            const analyser = harness.audioContext.analyser;

            analyser.setLevel(0);
            vi.advanceTimersByTime(7500);
            analyser.setLevel(0.5);
            vi.advanceTimersByTime(2000);
            analyser.setLevel(0);
            vi.advanceTimersByTime(5500);

            expect(harness.warnings)
                .toEqual([15, 14, 13, 0, 15]);
        });

        it('resets the silence clock when sound returns', () => {
            const harness = createHarness();
            const analyser = harness.audioContext.analyser;

            analyser.setLevel(0);
            vi.advanceTimersByTime(15000);
            analyser.setLevel(0.5);
            vi.advanceTimersByTime(CHECK_MS);
            analyser.setLevel(0);
            vi.advanceTimersByTime(15000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(6000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });
    });

    describe('suspended context', () => {
        it('treats a suspended context as sound and never reports SILENCE', () => {
            const harness = createHarness();

            harness.audioContext.state = 'suspended';
            vi.advanceTimersByTime(LIMIT_MS * 2);

            expect(harness.reportedProblems)
                .toEqual([]);
            expect(harness.warnings)
                .toEqual([]);
        });

        it('does not read the analyser while the context is suspended', () => {
            const harness = createHarness();

            harness.audioContext.state = 'suspended';
            vi.advanceTimersByTime(LIMIT_MS);

            expect(harness.audioContext.analyser.readCount)
                .toBe(0);
        });

        it('counts silence again only after the context is running', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(10000);
            harness.audioContext.state = 'suspended';
            vi.advanceTimersByTime(30000);
            harness.audioContext.state = 'running';
            vi.advanceTimersByTime(19000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(2000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });
    });

    describe('visibility', () => {
        it('resumes the context when the page becomes visible', () => {
            const harness = createHarness();
            const resumeSpy = vi.spyOn(harness.audioContext, 'resume');

            setVisibilityAndNotify('hidden');

            expect(resumeSpy).not.toHaveBeenCalled();

            setVisibilityAndNotify('visible');

            expect(resumeSpy)
                .toHaveBeenCalledTimes(1);
        });
    });

    describe('throttled checks', () => {
        it('does not count a long gap between checks as silence', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(10000);

            // A throttled background tab wakes up 30 seconds late.
            vi.setSystemTime(Date.now() + 30000);
            vi.advanceTimersByTime(CHECK_MS);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(19000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(2000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });

        it('still warns and reports SILENCE when checks arrive once a second', () => {
            // A hidden tab runs timers about once a second, whatever the requested delay.
            const fakeSetInterval = globalThis.setInterval;

            vi.stubGlobal('setInterval', (callback: () => void) => fakeSetInterval(callback, 1000));

            const harness = createHarness();

            vi.advanceTimersByTime(LIMIT_MS);

            expect(harness.warnings)
                .toEqual(FULL_COUNTDOWN);
            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });

        it('restarts the silence clock after a 2500 ms gap', () => {
            const harness = createHarness();

            vi.advanceTimersByTime(1000);

            // The next check lands 2500 ms after the last one.
            vi.setSystemTime(Date.now() + 2250);
            vi.advanceTimersByTime(3000);

            expect(harness.warnings)
                .toEqual([]);
            expect(harness.reportedProblems)
                .toEqual([]);
        });
    });

    describe('pause and resume', () => {
        it('clears the warning on pause and stops checking', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(7500);
            harness.monitor.pause();

            expect(harness.warnings)
                .toEqual([15, 14, 13, 0]);

            const readsAtPause = harness.audioContext.analyser.readCount;

            vi.advanceTimersByTime(LIMIT_MS * 2);

            expect(harness.warnings)
                .toEqual([15, 14, 13, 0]);
            expect(harness.audioContext.analyser.readCount)
                .toBe(readsAtPause);
        });

        it('does not report SILENCE while paused, however long the pause', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(10000);
            harness.monitor.pause();
            vi.advanceTimersByTime(LIMIT_MS * 3);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('restarts the silence clock on resume, so paused time does not count', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(10000);
            harness.monitor.pause();
            vi.advanceTimersByTime(60000);
            harness.monitor.resume();
            vi.advanceTimersByTime(19000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(2000);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });

        it('reads the analyser again after resume', () => {
            const harness = createHarness();

            harness.monitor.pause();
            harness.monitor.resume();

            const readsAtResume = harness.audioContext.analyser.readCount;

            vi.advanceTimersByTime(CHECK_MS * 4);

            expect(harness.audioContext.analyser.readCount)
                .toBeGreaterThan(readsAtResume);
        });
    });

    describe('release', () => {
        it('stops checking the analyser and reports nothing afterwards', () => {
            const harness = createHarness();

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(7500);
            harness.monitor.release();

            const readsAtRelease = harness.audioContext.analyser.readCount;
            const warningsAtRelease = [...harness.warnings];

            vi.advanceTimersByTime(LIMIT_MS * 2);

            expect(harness.audioContext.analyser.readCount)
                .toBe(readsAtRelease);
            expect(harness.warnings)
                .toEqual(warningsAtRelease);
            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('closes the AudioContext it created, once, even when released twice', () => {
            const harness = createHarness();
            const closeSpy = vi.spyOn(harness.audioContext, 'close');

            harness.monitor.release();
            harness.monitor.release();

            expect(closeSpy)
                .toHaveBeenCalledTimes(1);
        });

        it('removes the visibilitychange listener', () => {
            const harness = createHarness();
            const resumeSpy = vi.spyOn(harness.audioContext, 'resume');

            harness.monitor.release();
            setVisibilityAndNotify('visible');

            expect(resumeSpy).not.toHaveBeenCalled();
        });

        it('ignores an error from close()', async () => {
            const harness = createHarness();

            // Not a spy: a spy would handle the rejection itself and hide an unhandled one.
            harness.audioContext.close = (): Promise<void> => Promise.reject(new Error('Already closed'));

            expect(() => {
                harness.monitor.release();
            }).not.toThrow();

            await waitForUnhandledRejections();
        });

        it('ignores an error from resume()', async () => {
            const harness = createHarness();

            harness.audioContext.resume = (): Promise<void> => Promise.reject(new Error('Not allowed'));

            expect(() => {
                setVisibilityAndNotify('visible');
            }).not.toThrow();

            await waitForUnhandledRejections();
        });

        it('ignores an error thrown synchronously by resume()', () => {
            const harness = createHarness();

            vi.spyOn(harness.audioContext, 'resume')
                .mockImplementation(() => {
                    throw new Error('Not allowed');
                });

            expect(() => {
                setVisibilityAndNotify('visible');
            }).not.toThrow();
        });
    });

    describe('options', () => {
        it('reads the analyser every checkIntervalMs', () => {
            const harness = createHarness({ checkIntervalMs: 1000 });

            vi.advanceTimersByTime(1000);

            const readsAfterOneSecond = harness.audioContext.analyser.readCount;

            vi.advanceTimersByTime(2000);

            expect(harness.audioContext.analyser.readCount - readsAfterOneSecond)
                .toBe(2);
        });

        it('starts the countdown after a custom warningMs', () => {
            const harness = createHarness({ warningMs: 2000 });

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(1750);

            expect(harness.warnings)
                .toEqual([]);

            vi.advanceTimersByTime(500);

            expect(harness.warnings)
                .toEqual([18]);
        });

        it('reports SILENCE at a custom limitMs, with the countdown ending before it', () => {
            const harness = createHarness({ limitMs: 3000, warningMs: 1000 });

            harness.audioContext.analyser.setLevel(0);
            vi.advanceTimersByTime(2750);

            expect(harness.warnings)
                .toEqual([2, 1]);
            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(500);

            expect(harness.reportedProblems)
                .toEqual(['SILENCE']);
        });
    });
});
