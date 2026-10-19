import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { RecorderError } from '../errors/RecorderError';
import { RecordingStore } from '../storage/RecordingStore';
import type { MonitorContext, MonitorFactory } from '../monitors';
import {
    FakeMediaStreamTrack,
    createFakeStream,
    stubMediaDevices,
    stubNavigatorWithoutMediaDevices,
} from '../../test/helpers/fakeMedia';
import { installFakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import type { FakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import { DurableRecorder } from './DurableRecorder';
import type {
    DurableRecorderEvents,
    DurableRecorderOptions,
    FinishedRecording,
    RecorderState,
} from './recorderTypes';

const AUDIO_TYPE = 'audio/webm;codecs=opus';
const DEFAULT_TIMESLICE_MS = 500;
const PROGRESS_INTERVAL_MS = 250;
const STOP_EVENT_TIMEOUT_MS = 2000;

interface FakeMonitor {
    noteData: Mock<() => void>;
    pause: Mock<() => void>;
    resume: Mock<() => void>;
    release: Mock<() => void>;
}

interface MonitorProbe {
    factory: MonitorFactory;
    contexts: MonitorContext[];
    monitors: FakeMonitor[];
}

interface Session {
    recorder: DurableRecorder;
    store: RecordingStore;
    stream: MediaStream;
    track: FakeMediaStreamTrack;
    recorders: FakeMediaRecorder[];
    probe: MonitorProbe;
}

let factory: IDBFactory;

function firstOf<Item>(items: Item[]): Item {
    const [first] = items;

    if (first === undefined) {
        throw new Error('Expected at least one item');
    }

    return first;
}

function lastOf<Item>(items: Item[]): Item {
    const last = items.at(-1);

    if (last === undefined) {
        throw new Error('Expected at least one item');
    }

    return last;
}

function requireId(recorder: DurableRecorder): string {
    const id = recorder.recordingId;

    if (id === null) {
        throw new Error('Expected an active recording id');
    }

    return id;
}

function requireFinished(result: FinishedRecording | null): FinishedRecording {
    if (result === null) {
        throw new Error('Expected a finished recording, got null');
    }

    return result;
}

// Waits for a promise to reject and returns the reason. Fails if it resolves.
async function captureRejection(attempt: Promise<unknown>): Promise<unknown> {
    try {
        await attempt;
    } catch (error) {
        return error;
    }

    throw new Error('Expected the promise to reject');
}

function createMonitorProbe(): MonitorProbe {
    const contexts: MonitorContext[] = [];
    const monitors: FakeMonitor[] = [];
    const factory: MonitorFactory = (context) => {
        const monitor: FakeMonitor = {
            noteData: vi.fn<() => void>(),
            pause: vi.fn<() => void>(),
            resume: vi.fn<() => void>(),
            release: vi.fn<() => void>(),
        };

        contexts.push(context);
        monitors.push(monitor);

        return monitor;
    };

    return { factory, contexts, monitors };
}

// One microphone, one fake MediaRecorder and a real store. The default
// minRecordingBytes is 1 here so most tests do not hit the EMPTY rule.
function createSession(overrides: Partial<DurableRecorderOptions> = {}): Session {
    const browser = installFakeMediaRecorder({ supportedTypes: [AUDIO_TYPE] });
    const track = new FakeMediaStreamTrack('audio');
    const stream = createFakeStream([track]);
    const store = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });
    const probe = createMonitorProbe();

    stubMediaDevices({ getUserMedia: { resolve: stream } });

    const recorder = new DurableRecorder({
        store,
        minRecordingBytes: 1,
        metadata: { title: 'standup' },
        monitors: [probe.factory],
        ...overrides,
    });

    return { recorder, store, stream, track, recorders: browser.recorders, probe };
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

async function readBytes(blob: Blob): Promise<Uint8Array> {
    const buffer = await blob.arrayBuffer();

    return new Uint8Array(buffer);
}

function createProblemSpy(): Mock<(payload: DurableRecorderEvents['problem']) => void> {
    return vi.fn<(payload: DurableRecorderEvents['problem']) => void>();
}

describe('DurableRecorder', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        factory = new IDBFactory();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('isSupported', () => {
        it('reports whether the source can be recorded in this browser', () => {
            installFakeMediaRecorder();
            stubMediaDevices({ getUserMedia: { resolve: createFakeStream([]) } });

            expect(DurableRecorder.isSupported())
                .toBe(true);
            expect(DurableRecorder.isSupported('screen'))
                .toBe(false);
        });
    });

    describe('start', () => {
        it('rethrows a RecorderError from acquireStream as is', async () => {
            installFakeMediaRecorder();
            stubNavigatorWithoutMediaDevices();
            const recorder = new DurableRecorder({ store: null, monitors: [] });

            const reason = await captureRejection(recorder.start());

            expect(reason)
                .toBeInstanceOf(RecorderError);
            expect(reason)
                .toMatchObject({ code: 'UNSUPPORTED' });
            expect(reason).not.toHaveProperty('cause');
            expect(recorder.state)
                .toBe('idle');
        });

        it('maps a denied permission to DENIED and keeps the browser error as cause', async () => {
            installFakeMediaRecorder();
            const denied = new DOMException('Permission denied', 'NotAllowedError');

            stubMediaDevices({ getUserMedia: { reject: denied } });
            const recorder = new DurableRecorder({ store: null, monitors: [] });

            const reason = await captureRejection(recorder.start());

            expect(reason)
                .toBeInstanceOf(RecorderError);
            expect(reason)
                .toMatchObject({ code: 'DENIED' });
            expect(reason)
                .toHaveProperty('cause', denied);
            expect(recorder.state)
                .toBe('idle');
        });

        it('maps a MediaRecorder constructor failure and releases the stream', async () => {
            const session = createSession();
            const browser = installFakeMediaRecorder({
                supportedTypes: [AUDIO_TYPE],
                constructorError: new DOMException('Options not supported', 'NotSupportedError'),
            });

            const reason = await captureRejection(session.recorder.start());

            expect(reason)
                .toMatchObject({ code: 'UNSUPPORTED' });
            expect(browser.recorders)
                .toHaveLength(0);
            expect(session.track.stopCount)
                .toBe(1);
            expect(session.recorder.state)
                .toBe('idle');
        });

        it('maps a start failure to its code and releases the stream', async () => {
            const session = createSession();

            installFakeMediaRecorder({
                supportedTypes: [AUDIO_TYPE],
                startError: new DOMException('Microphone in use', 'NotReadableError'),
            });

            const reason = await captureRejection(session.recorder.start());

            expect(reason)
                .toMatchObject({ code: 'DEVICE_BUSY' });
            expect(session.track.stopCount)
                .toBe(1);
            expect(firstOf(session.probe.monitors).release)
                .toHaveBeenCalledTimes(1);
            expect(session.recorder.state)
                .toBe('idle');
        });

        it('rejects a second start while recording', async () => {
            const session = createSession();

            await session.recorder.start();

            await expect(session.recorder.start()).rejects.toThrow('DurableRecorder is already recording');
            expect(session.recorder.state)
                .toBe('recording');
        });

        it('rejects a second start while the first one is still starting', async () => {
            const session = createSession();

            const firstStart = session.recorder.start();

            await expect(session.recorder.start()).rejects.toThrow('DurableRecorder is already recording');
            await firstStart;
        });

        it('moves through starting and recording and starts MediaRecorder with the default timeslice', async () => {
            const session = createSession();
            const states = collectStates(session.recorder);

            const mediaRecorder = await startSession(session);

            expect(states)
                .toEqual(['starting', 'recording']);
            expect(mediaRecorder.startCount)
                .toBe(1);
            expect(mediaRecorder.timeslice)
                .toBe(DEFAULT_TIMESLICE_MS);
        });

        it('passes the picked mimeType and the bitrates to MediaRecorder', async () => {
            const session = createSession({ mimeType: AUDIO_TYPE, audioBitsPerSecond: 64000 });

            const mediaRecorder = await startSession(session);

            expect(mediaRecorder.requestedOptions)
                .toEqual({ mimeType: AUDIO_TYPE, audioBitsPerSecond: 64000 });
        });

        it('leaves out the options that are not set', async () => {
            const session = createSession();

            const mediaRecorder = await startSession(session);

            expect(mediaRecorder.requestedOptions).not.toHaveProperty('audioBitsPerSecond');
            expect(mediaRecorder.requestedOptions).not.toHaveProperty('videoBitsPerSecond');
        });

        it('starts each monitor with the stream and the problem callbacks', async () => {
            const session = createSession();

            await session.recorder.start();

            const context = firstOf(session.probe.contexts);

            expect(context.stream)
                .toBe(session.stream);
            expect(context.reportProblem)
                .toBeTypeOf('function');
            expect(context.warnSilence)
                .toBeTypeOf('function');
        });

        it('saves the recording metadata to the store', async () => {
            const session = createSession();

            await session.recorder.start();
            const id = session.recorder.recordingId;
            const metas = await session.store.list();

            expect(id).not.toBeNull();
            expect(metas)
                .toHaveLength(1);
            expect(metas[0])
                .toMatchObject({
                    id,
                    mimeType: AUDIO_TYPE,
                    source: 'audio',
                    metadata: { title: 'standup' },
                    nextSegment: 1,
                });
        });

        it('keeps the recorder idle and releases a stream that arrives after cancel', async () => {
            const session = createSession();
            let resolveStream: (stream: MediaStream) => void = () => undefined;
            const pendingStream = new Promise<MediaStream>((resolve) => {
                resolveStream = resolve;
            });
            const lateTrack = new FakeMediaStreamTrack('audio');

            vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pendingStream } });

            const startAttempt = session.recorder.start()
                .catch((error: unknown) => error);
            const cancelled = session.recorder.cancel();

            resolveStream(createFakeStream([lateTrack]));
            await cancelled;

            expect(session.recorder.state)
                .toBe('idle');

            await startAttempt;

            expect(session.recorder.state)
                .toBe('idle');
            expect(lateTrack.stopCount)
                .toBe(1);
            expect(session.recorders)
                .toHaveLength(0);
        });
    });

    describe('slices', () => {
        it('stores the slices in the order they arrive', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(4, 1);
            mediaRecorder.emitSlice(4, 2);
            mediaRecorder.emitSlice(4, 3);
            const finished = requireFinished(await session.recorder.stop());
            const stored = await session.store.load(finished.id);
            const segment = firstOf(stored?.segments ?? []);

            expect(Array.from(await readBytes(segment)))
                .toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
        });

        it('ignores empty slices and tells the monitors about each real slice', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(0);
            mediaRecorder.emitSlice(5);
            const finished = requireFinished(await session.recorder.stop());

            expect(finished.sizeBytes)
                .toBe(5);
            expect(firstOf(session.probe.monitors).noteData)
                .toHaveBeenCalledTimes(1);
        });

        it('emits progress with the new size after each slice', async () => {
            const session = createSession();
            const onProgress = vi.fn();

            session.recorder.on('progress', onProgress);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            expect(session.recorder.progress.sizeBytes)
                .toBe(10);
            expect(onProgress)
                .toHaveBeenCalledWith(expect.objectContaining({ sizeBytes: 10 }));
        });
    });

    describe('progress', () => {
        it('emits progress every 250 ms with the elapsed time', async () => {
            const session = createSession();
            const onProgress = vi.fn();

            session.recorder.on('progress', onProgress);
            await session.recorder.start();

            vi.advanceTimersByTime(2 * PROGRESS_INTERVAL_MS);

            expect(onProgress)
                .toHaveBeenNthCalledWith(1, { durationMs: 250, sizeBytes: 0 });
            expect(onProgress)
                .toHaveBeenNthCalledWith(2, { durationMs: 500, sizeBytes: 0 });
            expect(session.recorder.progress.durationMs)
                .toBe(500);
        });

        it('stops the progress timer when the recording stops', async () => {
            const session = createSession();
            const onProgress = vi.fn();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);
            await session.recorder.stop();
            session.recorder.on('progress', onProgress);

            vi.advanceTimersByTime(5 * PROGRESS_INTERVAL_MS);

            expect(onProgress).not.toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('resolves null when nothing is recording', async () => {
            const session = createSession();

            await expect(session.recorder.stop()).resolves.toBeNull();
        });

        it('returns the finished recording and emits finish with the same object', async () => {
            const session = createSession();
            const onFinish = vi.fn();

            session.recorder.on('finish', onFinish);
            const mediaRecorder = await startSession(session);
            const id = session.recorder.recordingId;

            mediaRecorder.emitSlice(100, 7);
            vi.advanceTimersByTime(1500);

            const finished = requireFinished(await session.recorder.stop());

            expect(finished)
                .toMatchObject({
                    id,
                    mimeType: AUDIO_TYPE,
                    extension: 'webm',
                    durationMs: 1500,
                    sizeBytes: 100,
                    metadata: { title: 'standup' },
                });
            expect(finished.blob.size)
                .toBe(100);
            expect(finished.blob.type)
                .toBe(AUDIO_TYPE);
            expect(onFinish)
                .toHaveBeenCalledWith(finished);
            expect(session.recorder.recordingId)
                .toBeNull();
        });

        it('emits the states in order from start to stop', async () => {
            const session = createSession();
            const states = collectStates(session.recorder);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            await session.recorder.stop();

            expect(states)
                .toEqual(['starting', 'recording', 'stopping', 'idle']);
        });

        it('returns the same promise when stop is called again while stopping', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            const firstStop = session.recorder.stop();
            const secondStop = session.recorder.stop();

            expect(secondStop)
                .toBe(firstStop);
            await firstStop;
        });

        it('stops MediaRecorder and releases the monitors and the stream', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            await session.recorder.stop();

            expect(mediaRecorder.stopCount)
                .toBe(1);
            expect(firstOf(session.probe.monitors).release)
                .toHaveBeenCalledTimes(1);
            expect(session.track.stopCount)
                .toBe(1);
            expect(vi.getTimerCount())
                .toBe(0);
        });

        it('saves the stop time as updatedAt in the store', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);
            const id = requireId(session.recorder);

            mediaRecorder.emitSlice(10);
            vi.advanceTimersByTime(1500);
            await session.recorder.stop();

            const stored = await session.store.load(id);

            expect(stored?.updatedAt)
                .toBe((stored?.createdAt ?? 0) + 1500);
        });

        it('keeps the stored recording after a successful stop until the app deletes it', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            const finished = requireFinished(await session.recorder.stop());

            expect(await session.store.load(finished.id)).not.toBeNull();
            await session.store.delete(finished.id);
            expect(await session.store.load(finished.id))
                .toBeNull();
        });

        it('returns the blob that finalize returns and passes the mime type to it', async () => {
            const finalize = vi.fn((recording: Blob, mimeType: string): Promise<Blob> => {
                return Promise.resolve(new Blob([recording.slice(0, 5)], { type: mimeType }));
            });
            const session = createSession({ finalize });
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(100);

            const finished = requireFinished(await session.recorder.stop());

            expect(finalize)
                .toHaveBeenCalledWith(expect.any(Blob), AUDIO_TYPE);
            expect(finished.blob.size)
                .toBe(5);
        });

        it('keeps the original blob when finalize fails', async () => {
            const finalize = vi.fn(() => Promise.reject(new Error('remux failed')));
            const session = createSession({ finalize });
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(100);

            const finished = requireFinished(await session.recorder.stop());

            expect(finalize)
                .toHaveBeenCalledTimes(1);
            expect(finished.blob.size)
                .toBe(100);
        });

        it('resolves null, emits EMPTY and deletes the stored copy when the recording is under minRecordingBytes', async () => {
            const session = createSession({ minRecordingBytes: 1024 });
            const onProblem = vi.fn();
            const onFinish = vi.fn();

            session.recorder.on('problem', onProblem);
            session.recorder.on('finish', onFinish);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            const result = await session.recorder.stop();

            expect(result)
                .toBeNull();
            expect(onProblem)
                .toHaveBeenCalledTimes(1);
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'EMPTY' }));
            expect(onFinish).not.toHaveBeenCalled();
            expect(await session.store.list())
                .toEqual([]);
            expect(session.recorder.state)
                .toBe('idle');
        });

        it('does not emit EMPTY when a problem was already emitted', async () => {
            const session = createSession({ minRecordingBytes: 1024 });
            const onProblem = vi.fn();

            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(10);

            firstOf(session.probe.contexts)
                .reportProblem('NO_DATA');
            const result = await session.recorder.stop();

            expect(result)
                .toBeNull();
            expect(onProblem)
                .toHaveBeenCalledTimes(1);
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_DATA' }));
        });

        it('works without a store and keeps the blob in memory', async () => {
            const session = createSession({ store: null });
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(300);
            expect(session.recorder.recordingId).not.toBeNull();

            const finished = requireFinished(await session.recorder.stop());

            expect(finished.blob.size)
                .toBe(300);
        });
    });

    describe('cancel', () => {
        it('resolves when nothing is recording', async () => {
            const session = createSession();

            await expect(session.recorder.cancel()).resolves.toBeUndefined();
        });

        it('drops the recording without finish or EMPTY, deletes the stored copy and releases the stream', async () => {
            const session = createSession({ minRecordingBytes: 1024 });
            const onFinish = vi.fn();
            const onProblem = createProblemSpy();

            session.recorder.on('finish', onFinish);
            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);
            const id = requireId(session.recorder);

            mediaRecorder.emitSlice(100);

            await session.recorder.cancel();

            expect(await session.store.load(id))
                .toBeNull();
            expect(onFinish).not.toHaveBeenCalled();
            expect(onProblem).not.toHaveBeenCalled();
            expect(session.recorder.state)
                .toBe('idle');
            expect(mediaRecorder.stopCount)
                .toBe(1);
            expect(session.track.stopCount)
                .toBe(1);
            expect(firstOf(session.probe.monitors).release)
                .toHaveBeenCalledTimes(1);
        });
    });

    describe('problems', () => {
        it('stops once when a monitor reports a problem and ignores later ones', async () => {
            const session = createSession();
            const onProblem = vi.fn();

            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(2048);
            const context = firstOf(session.probe.contexts);

            context.reportProblem('NO_DATA');
            context.reportProblem('SILENCE');
            const finished = requireFinished(await session.recorder.stop());

            expect(onProblem)
                .toHaveBeenCalledTimes(1);
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_DATA' }));
            expect(mediaRecorder.stopCount)
                .toBe(1);
            expect(finished.sizeBytes)
                .toBe(2048);
        });

        it('wraps the problem code in a RecorderError', async () => {
            const session = createSession();
            const onProblem = createProblemSpy();

            session.recorder.on('problem', onProblem);
            await session.recorder.start();

            firstOf(session.probe.contexts)
                .reportProblem('INTERRUPTED');
            await session.recorder.stop();

            const payload = firstOf(onProblem.mock.calls)[0];

            expect(payload.error)
                .toBeInstanceOf(RecorderError);
            expect(payload.error)
                .toMatchObject({ code: 'INTERRUPTED' });
        });

        it('reports a MediaRecorder error event as INTERRUPTED and stops', async () => {
            const session = createSession();
            const onProblem = vi.fn();

            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitError(new DOMException('Recorder failed', 'UnknownError'));
            await session.recorder.stop();

            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERRUPTED' }));
            expect(mediaRecorder.stopCount)
                .toBe(1);
        });

        it('ignores problems that arrive after the recording has stopped', async () => {
            const session = createSession();
            const onProblem = vi.fn();

            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(2048);
            await session.recorder.stop();

            firstOf(session.probe.contexts)
                .reportProblem('NO_DATA');

            expect(onProblem).not.toHaveBeenCalled();
        });

        it('passes warnSilence through as a silence event', async () => {
            const session = createSession();
            const onSilence = vi.fn();

            session.recorder.on('silence', onSilence);
            await session.recorder.start();

            firstOf(session.probe.contexts)
                .warnSilence(3);
            firstOf(session.probe.contexts)
                .warnSilence(0);

            expect(onSilence)
                .toHaveBeenNthCalledWith(1, { secondsLeft: 3 });
            expect(onSilence)
                .toHaveBeenNthCalledWith(2, { secondsLeft: 0 });
        });
    });

    describe('storage errors', () => {
        it('treats a QuotaExceededError on save as STORAGE_FULL and stops', async () => {
            const session = createSession();
            const quota = new DOMException('Disk full', 'QuotaExceededError');

            vi.spyOn(session.store, 'appendChunk')
                .mockRejectedValue(quota);
            const onProblem = vi.fn();
            const onStorageError = vi.fn();

            session.recorder.on('problem', onProblem);
            session.recorder.on('storage-error', onStorageError);
            const mediaRecorder = await startSession(session);
            const idle = waitForIdle(session.recorder);

            mediaRecorder.emitSlice(2048);
            await idle;

            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'STORAGE_FULL' }));
            expect(onStorageError).not.toHaveBeenCalled();
            expect(session.recorder.state)
                .toBe('idle');
        });

        it('reports another storage error once and keeps recording in memory', async () => {
            const session = createSession();
            const write = vi.spyOn(session.store, 'appendChunk')
                .mockRejectedValue(new Error('disk offline'));
            const onStorageError = vi.fn();
            const onProblem = vi.fn();

            session.recorder.on('storage-error', onStorageError);
            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(100);
            mediaRecorder.emitSlice(100);
            mediaRecorder.emitSlice(100);
            const finished = requireFinished(await session.recorder.stop());

            expect(onStorageError)
                .toHaveBeenCalledTimes(1);
            expect(onProblem).not.toHaveBeenCalled();
            expect(write)
                .toHaveBeenCalledTimes(1);
            expect(finished.sizeBytes)
                .toBe(300);
        });

        it('reports a failed meta save as storage-error and still starts', async () => {
            const session = createSession();

            vi.spyOn(session.store, 'saveMeta')
                .mockRejectedValue(new Error('no database'));
            const onStorageError = vi.fn();

            session.recorder.on('storage-error', onStorageError);

            await session.recorder.start();

            expect(session.recorder.state)
                .toBe('recording');

            // stop() waits for queued writes, so the failed meta save is handled by then.
            await session.recorder.stop();

            expect(onStorageError)
                .toHaveBeenCalledTimes(1);
        });

        it('emits one problem when a quota error arrives after a monitor problem', async () => {
            const session = createSession();
            const onProblem = createProblemSpy();

            vi.spyOn(session.store, 'appendChunk')
                .mockRejectedValue(new DOMException('Storage is full', 'QuotaExceededError'));
            session.recorder.on('problem', onProblem);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(2048);
            firstOf(session.probe.contexts)
                .reportProblem('INTERRUPTED');
            await session.recorder.stop();

            expect(onProblem)
                .toHaveBeenCalledTimes(1);
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERRUPTED' }));
        });
    });

    describe('limits', () => {
        it('emits limit-near once when the byte ratio reaches warnAt', async () => {
            const session = createSession({ maxBytes: 1000, warnAt: 0.9 });
            const onNear = vi.fn();

            session.recorder.on('limit-near', onNear);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(950);
            mediaRecorder.emitSlice(10);

            expect(onNear)
                .toHaveBeenCalledTimes(1);
            expect(onNear)
                .toHaveBeenCalledWith({ kind: 'bytes', ratio: 0.95 });
        });

        it('emits limit once and stops when onLimit is stop, the default', async () => {
            const session = createSession({ maxBytes: 1000 });
            const onLimit = vi.fn();

            session.recorder.on('limit', onLimit);
            const mediaRecorder = await startSession(session);

            // The check runs after the slice, so the byte limit can overshoot by one slice.
            mediaRecorder.emitSlice(1200);

            expect(mediaRecorder.stopCount)
                .toBe(1);

            const finished = requireFinished(await session.recorder.stop());

            expect(onLimit)
                .toHaveBeenCalledTimes(1);
            expect(onLimit)
                .toHaveBeenCalledWith({ kind: 'bytes' });
            expect(mediaRecorder.stopCount)
                .toBe(1);
            expect(finished.sizeBytes)
                .toBe(1200);
        });

        it('emits limit once and keeps recording when onLimit is event', async () => {
            const session = createSession({ maxBytes: 1000, onLimit: 'event' });
            const onLimit = vi.fn();

            session.recorder.on('limit', onLimit);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(1200);
            mediaRecorder.emitSlice(100);

            expect(onLimit)
                .toHaveBeenCalledTimes(1);
            expect(mediaRecorder.stopCount)
                .toBe(0);
            expect(session.recorder.state)
                .toBe('recording');
        });

        it('emits duration limit-near and limit from the progress timer', async () => {
            const session = createSession({ maxDurationMs: 1000, warnAt: 0.5, onLimit: 'event' });
            const onNear = vi.fn();
            const onLimit = vi.fn();

            session.recorder.on('limit-near', onNear);
            session.recorder.on('limit', onLimit);
            await session.recorder.start();

            vi.advanceTimersByTime(1000);
            vi.advanceTimersByTime(1000);

            expect(onNear)
                .toHaveBeenCalledTimes(1);
            expect(onNear)
                .toHaveBeenCalledWith({ kind: 'duration', ratio: 0.5 });
            expect(onLimit)
                .toHaveBeenCalledTimes(1);
            expect(onLimit)
                .toHaveBeenCalledWith({ kind: 'duration' });
        });
    });

    describe('stop and monitor failures', () => {
        it('resolves stop and goes idle when MediaRecorder.stop throws', async () => {
            const session = createSession();
            const onFinish = vi.fn();

            session.recorder.on('finish', onFinish);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(2048);
            vi.spyOn(mediaRecorder, 'stop')
                .mockImplementation(() => {
                    throw new Error('stop failed');
                });

            const stopped = session.recorder.stop();

            await vi.advanceTimersByTimeAsync(STOP_EVENT_TIMEOUT_MS);
            const result = await stopped;

            expect(session.recorder.state)
                .toBe('idle');
            expect(onFinish)
                .toHaveBeenCalledTimes(result === null ? 0 : 1);
            expect(session.track.stopCount)
                .toBe(1);
        });

        it('resolves after the stop timeout with the slices received so far when no stop event arrives', async () => {
            const session = createSession();
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(1000);
            mediaRecorder.emitSlice(500);
            vi.spyOn(mediaRecorder, 'stop')
                .mockImplementation(() => undefined);

            let settled = false;
            const stopped = session.recorder.stop()
                .then((result) => {
                    settled = true;

                    return result;
                });

            await vi.advanceTimersByTimeAsync(STOP_EVENT_TIMEOUT_MS - 1);

            expect(settled)
                .toBe(false);

            await vi.advanceTimersByTimeAsync(1);

            const finished = requireFinished(await stopped);

            expect(finished.sizeBytes)
                .toBe(1500);
            expect(session.recorder.state)
                .toBe('idle');
        });

        it('still stops and releases the stream when a monitor release throws', async () => {
            const session = createSession();
            const onFinish = vi.fn();

            session.recorder.on('finish', onFinish);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(2048);
            firstOf(session.probe.monitors).release
                .mockImplementation(() => {
                    throw new Error('release failed');
                });

            const finished = requireFinished(await session.recorder.stop());

            expect(onFinish)
                .toHaveBeenCalledWith(finished);
            expect(session.recorder.state)
                .toBe('idle');
            expect(mediaRecorder.stopCount)
                .toBe(1);
            expect(session.track.stopCount)
                .toBe(1);
        });

        it('rejects start and releases the stream and earlier monitors when a later monitor factory throws', async () => {
            const probe = createMonitorProbe();
            const failure = new Error('monitor failed');
            const failing: MonitorFactory = () => {
                throw failure;
            };
            const session = createSession({ monitors: [probe.factory, failing] });

            const reason = await captureRejection(session.recorder.start());

            expect(reason)
                .toMatchObject({ code: 'INTERRUPTED' });
            expect(reason)
                .toHaveProperty('cause', failure);
            expect(firstOf(probe.monitors).release)
                .toHaveBeenCalledTimes(1);
            expect(session.track.stopCount)
                .toBe(1);
            expect(firstOf(session.recorders).startCount)
                .toBe(0);
            expect(session.recorder.state)
                .toBe('idle');
        });
    });

    describe('defaults and boundaries', () => {
        it('keeps a recording of exactly minRecordingBytes', async () => {
            const session = createSession({ minRecordingBytes: 1024 });
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(1024);
            const finished = requireFinished(await session.recorder.stop());

            expect(finished.sizeBytes)
                .toBe(1024);
        });

        it('treats 1023 bytes as EMPTY when minRecordingBytes is not set', async () => {
            const session = createSession();
            const recorder = new DurableRecorder({ store: session.store, monitors: [] });
            const onProblem = createProblemSpy();

            recorder.on('problem', onProblem);
            await recorder.start();
            lastOf(session.recorders)
                .emitSlice(1023);

            expect(await recorder.stop())
                .toBeNull();
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'EMPTY' }));
        });

        it('uses 0.9 as the default warnAt', async () => {
            const session = createSession({ maxBytes: 1000 });
            const onNear = vi.fn();

            session.recorder.on('limit-near', onNear);
            const mediaRecorder = await startSession(session);

            mediaRecorder.emitSlice(800);

            expect(onNear)
                .not.toHaveBeenCalled();

            mediaRecorder.emitSlice(150);

            expect(onNear)
                .toHaveBeenCalledWith({ kind: 'bytes', ratio: 0.95 });

            await session.recorder.stop();
        });

        it('records audio/webm when neither MediaRecorder nor the picker gives a type', async () => {
            const session = createSession();
            const browser = installFakeMediaRecorder({ supportedTypes: [] });

            await session.recorder.start();
            lastOf(browser.recorders)
                .emitSlice(2048);
            const finished = requireFinished(await session.recorder.stop());

            expect(finished.mimeType)
                .toBe('audio/webm');
            expect(finished.extension)
                .toBe('webm');
        });

        it('uses the type MediaRecorder reports over the picked type', async () => {
            const session = createSession();
            const browser = installFakeMediaRecorder({
                supportedTypes: [AUDIO_TYPE],
                reportedMimeType: 'audio/ogg;codecs=opus',
            });

            await session.recorder.start();
            lastOf(browser.recorders)
                .emitSlice(2048);
            const finished = requireFinished(await session.recorder.stop());

            expect(finished.mimeType)
                .toBe('audio/ogg;codecs=opus');
        });

        it('uses the picked type when MediaRecorder reports an empty type', async () => {
            const session = createSession();
            const browser = installFakeMediaRecorder({
                supportedTypes: [AUDIO_TYPE],
                reportedMimeType: '',
            });

            await session.recorder.start();
            lastOf(browser.recorders)
                .emitSlice(2048);
            const finished = requireFinished(await session.recorder.stop());

            expect(finished.mimeType)
                .toBe(AUDIO_TYPE);
        });
    });

    describe('stop during start', () => {
        it('stops the recording once it starts and resolves null when it holds no data', async () => {
            const session = createSession();
            let resolveStream: (stream: MediaStream) => void = () => undefined;
            const pendingStream = new Promise<MediaStream>((resolve) => {
                resolveStream = resolve;
            });

            vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pendingStream } });

            const startAttempt = session.recorder.start();
            const stopped = session.recorder.stop();

            resolveStream(session.stream);
            await startAttempt;
            const result = await stopped;

            expect(result)
                .toBeNull();
            expect(lastOf(session.recorders).stopCount)
                .toBe(1);
            expect(session.recorder.state)
                .toBe('idle');
        });
    });
});
