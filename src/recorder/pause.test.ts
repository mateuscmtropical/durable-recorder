import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore } from '../storage/RecordingStore';
import { createInterruptionMonitor, createSilenceMonitor } from '../monitors';
import type { MonitorFactory, RecordingMonitor } from '../monitors';
import { FakeMediaStreamTrack, createFakeStream, stubMediaDevices } from '../../test/helpers/fakeMedia';
import { installFakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import type { FakeMediaRecorder, FakeMediaRecorderOptions } from '../../test/helpers/fakeMediaRecorder';
import { asAudioContext, createFakeAudioContext } from '../../test/helpers/fakeAudioContext';
import { DurableRecorder } from './DurableRecorder';
import type { DurableRecorderOptions, FinishedRecording, RecorderState } from './recorderTypes';

const AUDIO_TYPE = 'audio/webm;codecs=opus';
const NO_DATA_LIMIT_MS = 5000;
const SILENCE_LIMIT_MS = 20000;

interface Session {
    recorder: DurableRecorder;
    store: RecordingStore;
    track: FakeMediaStreamTrack;
    recorders: FakeMediaRecorder[];
}

type MergeSegments = NonNullable<DurableRecorderOptions['mergeSegments']>;

let factory: IDBFactory;

const joinParts: MergeSegments = (segments, mimeType) => {
    return Promise.resolve(new Blob(segments, { type: mimeType }));
};

function lastOf<Item>(items: Item[]): Item {
    const last = items.at(-1);

    if (last === undefined) {
        throw new Error('Expected at least one item');
    }

    return last;
}

function requireFinished(result: FinishedRecording | null): FinishedRecording {
    if (result === null) {
        throw new Error('Expected a finished recording, got null');
    }

    return result;
}

// One microphone, one fake MediaRecorder and a real store on fake-indexeddb.
// Monitors are off unless a test passes some.
function createSession(
    overrides: Partial<DurableRecorderOptions> = {},
    browserOptions: FakeMediaRecorderOptions = {},
): Session {
    const browser = installFakeMediaRecorder({ supportedTypes: [AUDIO_TYPE], ...browserOptions });
    const track = new FakeMediaStreamTrack('audio');
    const stream = createFakeStream([track]);
    const store = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });

    stubMediaDevices({ getUserMedia: { resolve: stream } });

    const recorder = new DurableRecorder({
        store,
        minRecordingBytes: 1,
        monitors: [],
        mergeSegments: joinParts,
        ...overrides,
    });

    return { recorder, store, track, recorders: browser.recorders };
}

async function startSession(session: Session): Promise<FakeMediaRecorder> {
    await session.recorder.start();

    return lastOf(session.recorders);
}

function collectStates(recorder: DurableRecorder): RecorderState[] {
    const states: RecorderState[] = [];

    recorder.on('state', (event) => {
        states.push(event.state);
    });

    return states;
}

// Resolves on the next idle state, so a test can wait for a stop it did not ask for.
function waitForIdle(recorder: DurableRecorder): Promise<void> {
    return new Promise<void>((resolve) => {
        const unsubscribe = recorder.on('state', (event) => {
            if (event.state === 'idle') {
                unsubscribe();
                resolve();
            }
        });
    });
}

describe('DurableRecorder pause and resume', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        factory = new IDBFactory();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('state', () => {
        it('moves from recording to paused and back, and emits each state', async () => {
            const session = createSession();
            const states = collectStates(session.recorder);
            const mediaRecorder = await startSession(session);

            session.recorder.pause();

            expect(session.recorder.state)
                .toBe('paused');

            session.recorder.resume();

            expect(session.recorder.state)
                .toBe('recording');
            expect(states)
                .toEqual(['starting', 'recording', 'paused', 'recording']);
            expect(mediaRecorder.pauseCount)
                .toBe(1);
            expect(mediaRecorder.resumeCount)
                .toBe(1);
        });

        it('ignores pause and resume when nothing is recording', () => {
            const session = createSession();
            const states = collectStates(session.recorder);

            session.recorder.pause();
            session.recorder.resume();

            expect(session.recorder.state)
                .toBe('idle');
            expect(states)
                .toEqual([]);
        });

        it('ignores pause while starting and resume while recording', async () => {
            const session = createSession();
            const starting = session.recorder.start();

            session.recorder.pause();
            await starting;
            session.recorder.resume();

            const mediaRecorder = lastOf(session.recorders);

            expect(session.recorder.state)
                .toBe('recording');
            expect(mediaRecorder.pauseCount)
                .toBe(0);
            expect(mediaRecorder.resumeCount)
                .toBe(0);
        });

        it('ignores a second pause, and pause and resume after stop', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            session.recorder.pause();
            session.recorder.pause();
            session.recorder.resume();
            await session.recorder.stop();
            session.recorder.pause();
            session.recorder.resume();

            expect(session.recorder.state)
                .toBe('idle');
            expect(mediaRecorder.pauseCount)
                .toBe(1);
            expect(mediaRecorder.resumeCount)
                .toBe(1);
        });

        it('keeps the state recording when the browser refuses pause', async () => {
            const session = createSession({}, { pauseError: new Error('Not allowed') });
            const states = collectStates(session.recorder);

            await startSession(session);

            const pauseAttempt = (): void => {
                session.recorder.pause();
            };

            expect(pauseAttempt)
                .not.toThrow();
            expect(session.recorder.state)
                .toBe('recording');
            expect(states)
                .toEqual(['starting', 'recording']);

            vi.advanceTimersByTime(1000);

            expect(session.recorder.progress.durationMs)
                .toBe(1000);
        });
    });

    describe('time', () => {
        it('counts only the active time in durationMs and progress', async () => {
            const session = createSession();
            const durations: number[] = [];

            session.recorder.on('progress', (progress) => {
                durations.push(progress.durationMs);
            });
            await startSession(session);

            vi.advanceTimersByTime(1000);
            session.recorder.pause();

            const durationsWhenPaused = durations.length;

            vi.advanceTimersByTime(1000);

            // Progress keeps firing while paused, with the same duration.
            expect(durations.slice(durationsWhenPaused))
                .toEqual([1000, 1000, 1000, 1000]);

            vi.advanceTimersByTime(4000);
            session.recorder.resume();
            vi.advanceTimersByTime(500);

            expect(session.recorder.progress.durationMs)
                .toBe(1500);
        });

        it('stores the active duration in the saved meta', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();
            vi.advanceTimersByTime(4000);
            session.recorder.resume();
            vi.advanceTimersByTime(500);

            const finished = requireFinished(await session.recorder.stop());
            const metas = await session.store.list();

            expect(finished.durationMs)
                .toBe(1500);
            expect(metas)
                .toMatchObject([{ durationMs: 1500 }]);
        });

        it('stop from paused resolves with the time up to the pause', async () => {
            const session = createSession();
            const states = collectStates(session.recorder);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();
            vi.advanceTimersByTime(3000);

            const finished = requireFinished(await session.recorder.stop());

            expect(finished.durationMs)
                .toBe(1000);
            expect(mediaRecorder.stopCount)
                .toBe(1);
            expect(states.slice(-2))
                .toEqual(['stopping', 'idle']);
        });

        it('cancel from paused drops the recording without a finish event', async () => {
            const session = createSession();
            const onFinish = vi.fn();

            session.recorder.on('finish', onFinish);

            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();

            await session.recorder.cancel();

            expect(session.recorder.state)
                .toBe('idle');
            expect(onFinish)
                .not.toHaveBeenCalled();
            expect(session.track.stopCount)
                .toBeGreaterThan(0);
            expect(await session.store.list())
                .toEqual([]);
        });
    });

    describe('monitors while paused', () => {
        it('pauses each monitor on pause and resumes it on resume', async () => {
            const monitor: RecordingMonitor = {
                noteData: vi.fn(),
                pause: vi.fn(),
                resume: vi.fn(),
                release: vi.fn(),
            };
            const monitorFactory: MonitorFactory = () => monitor;
            const session = createSession({ monitors: [monitorFactory] });

            await startSession(session);
            session.recorder.pause();

            expect(monitor.pause)
                .toHaveBeenCalledTimes(1);
            expect(monitor.resume)
                .not.toHaveBeenCalled();

            session.recorder.resume();

            expect(monitor.resume)
                .toHaveBeenCalledTimes(1);
        });

        it('does not report NO_DATA while paused', async () => {
            const session = createSession({ monitors: [createInterruptionMonitor()] });
            const onProblem = vi.fn();

            session.recorder.on('problem', onProblem);
            await startSession(session);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();
            vi.advanceTimersByTime(4 * NO_DATA_LIMIT_MS);

            expect(onProblem)
                .not.toHaveBeenCalled();
            expect(session.recorder.state)
                .toBe('paused');

            session.recorder.resume();
            vi.advanceTimersByTime(1000);

            expect(onProblem)
                .not.toHaveBeenCalled();
            expect(session.recorder.state)
                .toBe('recording');
        });

        it('still reports NO_DATA when the recording is not paused', async () => {
            const session = createSession({ monitors: [createInterruptionMonitor()] });
            const onProblem = vi.fn();
            const idle = waitForIdle(session.recorder);

            session.recorder.on('problem', onProblem);
            await startSession(session);
            vi.advanceTimersByTime(NO_DATA_LIMIT_MS + 1000);

            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_DATA' }));

            await idle;
        });

        it('does not report SILENCE while paused', async () => {
            const audioContext = createFakeAudioContext();
            const silenceMonitor = createSilenceMonitor({ createAudioContext: () => asAudioContext(audioContext) });
            const session = createSession({ monitors: [silenceMonitor] });
            const onProblem = vi.fn();

            audioContext.analyser.setLevel(0);
            session.recorder.on('problem', onProblem);
            await startSession(session);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();
            vi.advanceTimersByTime(4 * SILENCE_LIMIT_MS);

            expect(onProblem)
                .not.toHaveBeenCalled();
            expect(session.recorder.state)
                .toBe('paused');
        });

        it('still reports SILENCE when the recording is not paused', async () => {
            const audioContext = createFakeAudioContext();
            const silenceMonitor = createSilenceMonitor({ createAudioContext: () => asAudioContext(audioContext) });
            const session = createSession({ monitors: [silenceMonitor] });
            const onProblem = vi.fn();
            const idle = waitForIdle(session.recorder);

            audioContext.analyser.setLevel(0);
            session.recorder.on('problem', onProblem);
            await startSession(session);
            vi.advanceTimersByTime(SILENCE_LIMIT_MS);

            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'SILENCE' }));

            await idle;
        });

        it('stops the recording when a track ends while paused', async () => {
            const session = createSession({ monitors: [createInterruptionMonitor()] });
            const onProblem = vi.fn();
            const idle = waitForIdle(session.recorder);

            session.recorder.on('problem', onProblem);
            await startSession(session);
            session.recorder.pause();
            session.track.readyState = 'ended';
            session.track.dispatchEvent(new Event('ended'));

            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERRUPTED' }));

            await idle;
        });
    });

    describe('limits with pause', () => {
        it('does not count paused time toward maxDurationMs', async () => {
            const session = createSession({ maxDurationMs: 2000, onLimit: 'event' });
            const onLimit = vi.fn();

            session.recorder.on('limit', onLimit);
            await startSession(session);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();
            vi.advanceTimersByTime(5000);

            expect(onLimit)
                .not.toHaveBeenCalled();

            session.recorder.resume();
            vi.advanceTimersByTime(999);

            expect(onLimit)
                .not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);

            expect(onLimit)
                .toHaveBeenCalledTimes(1);
            expect(onLimit)
                .toHaveBeenCalledWith({ kind: 'duration' });
        });

        it('pauses at the byte limit after the limit event, instead of stopping', async () => {
            const session = createSession({ maxBytes: 1000, onLimit: 'pause' });
            let stateAtLimit: RecorderState | undefined;
            const onLimit = vi.fn(() => {
                stateAtLimit = session.recorder.state;
            });

            session.recorder.on('limit', onLimit);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(1200);

            expect(onLimit)
                .toHaveBeenCalledWith({ kind: 'bytes' });
            expect(stateAtLimit)
                .toBe('recording');
            expect(session.recorder.state)
                .toBe('paused');
            expect(mediaRecorder.pauseCount)
                .toBe(1);
            expect(mediaRecorder.stopCount)
                .toBe(0);
        });

        it('stays paused while the duration limit is still reached', async () => {
            const session = createSession({ maxDurationMs: 1000, onLimit: 'pause' });
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);
            vi.advanceTimersByTime(1000);

            expect(session.recorder.state)
                .toBe('paused');

            session.recorder.resume();

            expect(session.recorder.state)
                .toBe('paused');
            expect(mediaRecorder.resumeCount)
                .toBe(0);

            vi.advanceTimersByTime(5000);

            const finished = requireFinished(await session.recorder.stop());

            expect(finished.durationMs)
                .toBe(1000);
        });
    });

    describe('continued recording', () => {
        it('pauses a continued take and adds the stored duration', async () => {
            const session = createSession();
            const firstTake = await startSession(session);

            firstTake.emitSlice(10);
            vi.advanceTimersByTime(2000);

            const stored = requireFinished(await session.recorder.stop());

            await session.recorder.continueRecording(stored.id);

            const secondTake = lastOf(session.recorders);

            secondTake.emitSlice(10);
            vi.advanceTimersByTime(1000);
            session.recorder.pause();
            vi.advanceTimersByTime(4000);
            session.recorder.resume();
            vi.advanceTimersByTime(500);

            const finished = requireFinished(await session.recorder.stop());

            expect(finished.durationMs)
                .toBe(3500);
            expect(finished.segments)
                .toBe(2);
            expect(secondTake.pauseCount)
                .toBe(1);
        });
    });
});
