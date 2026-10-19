import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInterruptionMonitor } from './interruptionMonitor';
import type { InterruptionMonitorOptions } from './interruptionMonitor';
import type { MonitorContext, MonitorProblemCode, RecordingMonitor } from './RecordingMonitor';
import { asMediaStream, createFakeStream, createFakeTrack } from '../../test/helpers/fakeTrack';
import type { FakeMediaStreamTrack } from '../../test/helpers/fakeTrack';

// Large enough that NO_DATA never fires during a test. Used when a test is
// about track events or pause and should not depend on the no data check.
const NO_DATA_NEVER_FIRES: InterruptionMonitorOptions = { noDataLimitMs: 1_000_000 };

interface MonitorHarness {
    monitor: RecordingMonitor;
    reportedProblems: MonitorProblemCode[];
    tracks: FakeMediaStreamTrack[];
}

function createHarness(
    options?: InterruptionMonitorOptions,
    tracks: FakeMediaStreamTrack[] = [createFakeTrack({ kind: 'audio' })],
): MonitorHarness {
    const reportedProblems: MonitorProblemCode[] = [];
    const stream = createFakeStream(...tracks);
    const context: MonitorContext = {
        stream: asMediaStream(stream),
        reportProblem: (code) => {
            reportedProblems.push(code);
        },
        warnSilence: vi.fn(),
    };
    const createMonitor = createInterruptionMonitor(options);
    const monitor = createMonitor(context);

    return { monitor, reportedProblems, tracks };
}

describe('createInterruptionMonitor', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('ended tracks', () => {
        it('reports INTERRUPTED as soon as a track ends', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireEnded();

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('reports INTERRUPTED when only the video track of several tracks ends', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            tracks[1]?.fireEnded();

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('reports INTERRUPTED once when tracks end more than once', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            tracks.forEach((track) => {
                track.fireEnded();
            });
            tracks.forEach((track) => {
                track.fireEnded();
            });

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });
    });

    describe('muted tracks', () => {
        it('reports INTERRUPTED when a track stays muted for muteGraceMs', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(1999);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('does not report when unmute arrives within muteGraceMs', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(1000);
            audioTrack?.fireUnmute();
            vi.advanceTimersByTime(10000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('restarts the grace period when the track is muted again after an unmute', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(1000);
            audioTrack?.fireUnmute();
            vi.advanceTimersByTime(500);
            audioTrack?.fireMute();
            vi.advanceTimersByTime(1999);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('starts the mute timer when the video track of several tracks is muted', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            tracks[1]?.fireMute();
            vi.advanceTimersByTime(2000);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('cancels the mute timer when the muted track is unmuted', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            tracks[1]?.fireMute();
            tracks[1]?.fireUnmute();
            vi.advanceTimersByTime(10000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('keeps the mute timer while another muted track is still muted', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            tracks[0]?.fireMute();
            tracks[1]?.fireMute();
            vi.advanceTimersByTime(1000);
            tracks[0]?.fireUnmute();
            vi.advanceTimersByTime(999);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('cancels the mute timer once every muted track is unmuted', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            tracks[0]?.fireMute();
            tracks[1]?.fireMute();
            tracks[0]?.fireUnmute();
            tracks[1]?.fireUnmute();
            vi.advanceTimersByTime(10000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('reports the mute problem once and does not report again when the track ends later', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(2000);
            audioTrack?.fireEnded();
            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('uses the muteGraceMs option', () => {
            const harness = createHarness({ muteGraceMs: 500, noDataLimitMs: 1_000_000 });
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(499);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });
    });

    describe('no data check', () => {
        it('reports NO_DATA when no slice arrives for more than noDataLimitMs', () => {
            const harness = createHarness();

            vi.advanceTimersByTime(5000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(250);

            expect(harness.reportedProblems)
                .toEqual(['NO_DATA']);
        });

        it('restarts the no data clock on each noteData call', () => {
            const harness = createHarness();

            vi.advanceTimersByTime(4000);
            harness.monitor.noteData();
            vi.advanceTimersByTime(5000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(250);

            expect(harness.reportedProblems)
                .toEqual(['NO_DATA']);
        });

        it('does not report NO_DATA while slices keep arriving', () => {
            const harness = createHarness();

            Array.from({ length: 30 })
                .forEach(() => {
                    vi.advanceTimersByTime(1000);
                    harness.monitor.noteData();
                });

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('reports NO_DATA only once while no data keeps missing', () => {
            const harness = createHarness();

            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual(['NO_DATA']);
        });

        it('uses the checkIntervalMs and noDataLimitMs options', () => {
            const harness = createHarness({ checkIntervalMs: 1000, noDataLimitMs: 3000 });

            vi.advanceTimersByTime(3000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(999);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['NO_DATA']);
        });

        it('works with no options at all', () => {
            const harness = createHarness(undefined);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(2000);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });
    });

    describe('pause and resume', () => {
        it('stops the no data check while paused', () => {
            const harness = createHarness();

            harness.monitor.pause();
            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('does not count paused time toward noDataLimitMs', () => {
            const harness = createHarness();

            vi.advanceTimersByTime(1000);
            harness.monitor.pause();
            vi.advanceTimersByTime(60000);
            harness.monitor.resume();
            vi.advanceTimersByTime(5000);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(250);

            expect(harness.reportedProblems)
                .toEqual(['NO_DATA']);
        });

        it('cancels a pending mute timer on pause', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(1000);
            harness.monitor.pause();
            vi.advanceTimersByTime(10000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('starts the mute timer again on resume when a track is still muted', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(1000);
            harness.monitor.pause();
            vi.advanceTimersByTime(9000);
            harness.monitor.resume();
            vi.advanceTimersByTime(1999);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('does not start a mute timer on resume when the track was unmuted during pause', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            vi.advanceTimersByTime(1000);
            harness.monitor.pause();
            vi.advanceTimersByTime(1000);
            audioTrack?.fireUnmute();
            vi.advanceTimersByTime(8000);
            harness.monitor.resume();
            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('does not report a track muted during pause until the recording resumes', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            harness.monitor.pause();
            vi.advanceTimersByTime(1000);
            audioTrack?.fireMute();
            vi.advanceTimersByTime(10000);

            expect(harness.reportedProblems)
                .toEqual([]);

            harness.monitor.resume();
            vi.advanceTimersByTime(1999);

            expect(harness.reportedProblems)
                .toEqual([]);

            vi.advanceTimersByTime(1);

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('reports INTERRUPTED when a track ends while paused', () => {
            const harness = createHarness();
            const [audioTrack] = harness.tracks;

            harness.monitor.pause();
            audioTrack?.fireEnded();

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('keeps a single no data check when pause and resume are repeated', () => {
            const harness = createHarness();

            harness.monitor.pause();
            harness.monitor.pause();
            harness.monitor.resume();

            expect(vi.getTimerCount())
                .toBe(1);

            harness.monitor.resume();

            expect(vi.getTimerCount())
                .toBe(1);
        });
    });

    describe('report once', () => {
        it('reports each problem code at most once', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireEnded();
            audioTrack?.fireEnded();

            expect(harness.reportedProblems)
                .toEqual(['INTERRUPTED']);
        });

        it('reports NO_DATA and INTERRUPTED once each when both happen', () => {
            const harness = createHarness();
            const [audioTrack] = harness.tracks;

            vi.advanceTimersByTime(5250);
            audioTrack?.fireEnded();
            audioTrack?.fireEnded();
            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual(['NO_DATA', 'INTERRUPTED']);
        });
    });

    describe('release', () => {
        it('stops the no data check and clears every timer', () => {
            const harness = createHarness();

            harness.monitor.release();

            expect(vi.getTimerCount())
                .toBe(0);

            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('cancels a pending mute timer', () => {
            const harness = createHarness(NO_DATA_NEVER_FIRES);
            const [audioTrack] = harness.tracks;

            audioTrack?.fireMute();
            harness.monitor.release();

            expect(vi.getTimerCount())
                .toBe(0);

            vi.advanceTimersByTime(10000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('removes its ended, mute and unmute listeners from every track', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);
            const removeSpies = tracks.map(track => vi.spyOn(track, 'removeEventListener'));

            harness.monitor.release();

            removeSpies.forEach((removeSpy) => {
                expect(removeSpy)
                    .toHaveBeenCalledWith('ended', expect.any(Function));
                expect(removeSpy)
                    .toHaveBeenCalledWith('mute', expect.any(Function));
                expect(removeSpy)
                    .toHaveBeenCalledWith('unmute', expect.any(Function));
            });
        });

        it('reports nothing for track events after release', () => {
            const tracks = [createFakeTrack({ kind: 'audio' }), createFakeTrack({ kind: 'video' })];
            const harness = createHarness(NO_DATA_NEVER_FIRES, tracks);

            harness.monitor.release();
            tracks[0]?.fireEnded();
            tracks[1]?.fireMute();
            vi.advanceTimersByTime(60000);

            expect(harness.reportedProblems)
                .toEqual([]);
        });

        it('can be called twice without throwing', () => {
            const harness = createHarness();

            harness.monitor.release();

            expect(() => {
                harness.monitor.release();
            }).not.toThrow();
        });
    });
});
