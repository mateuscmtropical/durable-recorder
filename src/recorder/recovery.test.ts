import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore } from '../storage/RecordingStore';
import type { RecordingMeta, RecordingSourceKind } from '../storage/storageTypes';
import { FakeMediaStreamTrack, createFakeStream, stubMediaDevices } from '../../test/helpers/fakeMedia';
import type { MediaDevicesStub } from '../../test/helpers/fakeMedia';
import { installFakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import type { FakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import { DurableRecorder } from './DurableRecorder';
import type {
    DurableRecorderEvents,
    DurableRecorderOptions,
    FinishedRecording,
} from './recorderTypes';

const AUDIO_TYPE = 'audio/webm;codecs=opus';
const DAY_MS = 24 * 60 * 60 * 1000;

// Taken before the fake timers replace the global, so waiting never moves the fake clock.
const realSetTimeout = globalThis.setTimeout;

type MergeSegments = NonNullable<DurableRecorderOptions['mergeSegments']>;

interface Harness {
    recorder: DurableRecorder;
    store: RecordingStore;
    recorders: FakeMediaRecorder[];
    track: FakeMediaStreamTrack;
    stream: MediaStream;
    devices: MediaDevicesStub;
}

interface SeedOptions {
    id?: string;
    source?: RecordingSourceKind;
    mimeType?: string;
    metadata?: Record<string, unknown>;
    createdAt?: number;
    updatedAt?: number;
    durationMs?: number;
    segmentSizes?: number[];
}

let factory: IDBFactory;

// Joins the parts into one Blob, the way mergeSegments does for parts that match.
const joinParts: MergeSegments = (segments, mimeType) => {
    return Promise.resolve(segments.length === 0 ? null : new Blob(segments, { type: mimeType }));
};

// One microphone, one fake MediaRecorder and a real store on fake-indexeddb.
function createHarness(
    overrides: Partial<DurableRecorderOptions> = {},
    supportedTypes: string[] = [AUDIO_TYPE],
): Harness {
    const browser = installFakeMediaRecorder({ supportedTypes });
    const track = new FakeMediaStreamTrack('audio');
    const stream = createFakeStream([track]);
    const store = overrides.store ?? new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });

    const devices = stubMediaDevices({ getUserMedia: { resolve: stream } });

    const recorder = new DurableRecorder({
        store,
        minRecordingBytes: 1,
        monitors: [],
        mergeSegments: joinParts,
        ...overrides,
    });

    return { recorder, store, recorders: browser.recorders, track, stream, devices };
}

// Writes a stored recording the way an earlier session would have left it.
async function seedRecording(store: RecordingStore, options: SeedOptions = {}): Promise<string> {
    const id = options.id ?? 'stored';
    const sizes = options.segmentSizes ?? [2048];
    const now = Date.now();
    const meta: RecordingMeta = {
        id,
        mimeType: options.mimeType ?? AUDIO_TYPE,
        source: options.source ?? 'audio',
        createdAt: options.createdAt ?? now,
        updatedAt: options.updatedAt ?? now,
        metadata: options.metadata ?? { title: 'standup' },
        nextSegment: sizes.length,
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    };

    await store.saveMeta(meta);
    await Promise.all(sizes.map((size, segment) => store.appendChunk({
        recordingId: id,
        segment,
        position: 0,
        data: new ArrayBuffer(size),
    })));

    return id;
}

function lastOf<Item>(items: Item[]): Item {
    const item = items[items.length - 1];

    if (item === undefined) {
        throw new Error('Expected at least one item');
    }

    return item;
}

function requireId(recorder: DurableRecorder): string {
    const id = recorder.recordingId;

    if (id === null) {
        throw new Error('Expected a recording in progress');
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

function segmentSizes(stored: { segments: Blob[] } | null): number[] {
    return stored?.segments.map(segment => segment.size) ?? [];
}

// Polls the stored duration on a real timer, so the fake clock stays where the test put it.
async function waitForStoredDuration(
    store: RecordingStore,
    recordingId: string,
    durationMs: number,
    attempts = 200,
): Promise<void> {
    const stored = await store.load(recordingId);

    if (stored?.durationMs === durationMs) {
        return;
    }

    if (attempts === 0) {
        throw new Error(`Stored durationMs never reached ${String(durationMs)}, last value ${String(stored?.durationMs)}`);
    }

    await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 5);
    });

    return waitForStoredDuration(store, recordingId, durationMs, attempts - 1);
}

describe('DurableRecorder recovery', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        factory = new IDBFactory();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('retentionDays', () => {
        it('rejects a negative or NaN value', () => {
            expect(() => new DurableRecorder({ retentionDays: -1 }))
                .toThrow(new RangeError('retentionDays must be a number of days, 0 or more'));
            expect(() => new DurableRecorder({ retentionDays: Number.NaN }))
                .toThrow(RangeError);
        });

        it('accepts 0 and Infinity', () => {
            expect(() => new DurableRecorder({ retentionDays: 0 })).not.toThrow();
            expect(() => new DurableRecorder({ retentionDays: Number.POSITIVE_INFINITY })).not.toThrow();
        });

        it('expires recordings older than retentionDays in the default store', async () => {
            vi.stubGlobal('indexedDB', factory);
            const seeder = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });

            await seedRecording(seeder, { id: 'old', updatedAt: Date.now() - 2 * DAY_MS });
            await seedRecording(seeder, { id: 'recent', updatedAt: Date.now() - DAY_MS / 2 });
            const recorder = new DurableRecorder({ retentionDays: 1, monitors: [] });

            const recoverable = await recorder.listRecoverable();

            expect(recoverable.map(meta => meta.id))
                .toEqual(['recent']);
        });

        it('keeps a two day old recording when retentionDays is not set', async () => {
            vi.stubGlobal('indexedDB', factory);
            const seeder = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });

            await seedRecording(seeder, { id: 'old', updatedAt: Date.now() - 2 * DAY_MS });
            const recorder = new DurableRecorder({ monitors: [] });

            const recoverable = await recorder.listRecoverable();

            expect(recoverable.map(meta => meta.id))
                .toEqual(['old']);
        });

        it('ignores retentionDays when the app passes its own store', async () => {
            const store = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });

            await seedRecording(store, { id: 'old', updatedAt: Date.now() - 2 * DAY_MS });
            const recorder = new DurableRecorder({ store, retentionDays: 1, monitors: [] });

            const recoverable = await recorder.listRecoverable();

            expect(recoverable.map(meta => meta.id))
                .toEqual(['old']);
        });
    });

    describe('expiry on the first store touch', () => {
        it('prunes once, on the first store touch', async () => {
            const harness = createHarness();
            const prune = vi.spyOn(harness.store, 'pruneExpired');

            await harness.recorder.start();
            lastOf(harness.recorders)
                .emitSlice(100);
            await harness.recorder.stop();
            await harness.recorder.listRecoverable();
            await harness.recorder.listRecoverable();

            expect(prune)
                .toHaveBeenCalledTimes(1);
        });

        it('ignores a prune error and keeps recording', async () => {
            const harness = createHarness();
            const pruning = Promise.reject(new Error('prune failed'));
            const handled = vi.spyOn(pruning, 'catch');

            vi.spyOn(harness.store, 'pruneExpired')
                .mockReturnValue(pruning);

            await expect(harness.recorder.start()).resolves.toBeUndefined();
            expect(harness.recorder.state)
                .toBe('recording');
            await expect(harness.recorder.listRecoverable()).resolves.toEqual([]);

            // A rejection nobody handles would surface as an unhandled rejection.
            expect(handled)
                .toHaveBeenCalledTimes(1);
        });

        it('prunes the expired recording and keeps the one it starts', async () => {
            const store = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1, retentionDays: 0 });

            await seedRecording(store, { id: 'old', updatedAt: Date.now() - 1000 });
            const harness = createHarness({ store });

            await harness.recorder.start();
            const id = requireId(harness.recorder);

            lastOf(harness.recorders)
                .emitSlice(100);
            await harness.recorder.stop();

            expect(await store.load('old'))
                .toBeNull();
            expect(await store.load(id)).not.toBeNull();
        });
    });

    describe('durationMs in the store', () => {
        it('saves durationMs and updatedAt after each slice', async () => {
            const harness = createHarness();

            await harness.recorder.start();
            const id = requireId(harness.recorder);

            vi.advanceTimersByTime(1000);
            lastOf(harness.recorders)
                .emitSlice(100);

            await waitForStoredDuration(harness.store, id, 1000);

            vi.advanceTimersByTime(1500);
            lastOf(harness.recorders)
                .emitSlice(100);

            await waitForStoredDuration(harness.store, id, 2500);
            const stored = await harness.store.load(id);

            expect(stored?.updatedAt)
                .toBe((stored?.createdAt ?? 0) + 2500);
        });

        it('saves no meta between slices', async () => {
            const harness = createHarness();
            const save = vi.spyOn(harness.store, 'saveMeta');

            await harness.recorder.start();
            await vi.advanceTimersByTimeAsync(20000);

            expect(save)
                .toHaveBeenCalledTimes(1);
        });

        it('keeps durationMs at the last slice when the recording never stops', async () => {
            const harness = createHarness();

            await harness.recorder.start();
            const id = requireId(harness.recorder);

            vi.advanceTimersByTime(2500);
            lastOf(harness.recorders)
                .emitSlice(100);
            vi.advanceTimersByTime(500);

            await waitForStoredDuration(harness.store, id, 2500);
        });

        it('saves the stored duration plus the new take after each slice of a continued take', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'stored', durationMs: 10000 });
            await harness.recorder.continueRecording('stored');
            vi.advanceTimersByTime(1500);
            lastOf(harness.recorders)
                .emitSlice(300);

            await waitForStoredDuration(harness.store, 'stored', 11500);
        });

        it('saves durationMs and updatedAt on stop', async () => {
            const harness = createHarness();

            await harness.recorder.start();
            const id = requireId(harness.recorder);

            vi.advanceTimersByTime(1234);
            lastOf(harness.recorders)
                .emitSlice(100);

            // Time after the last slice is only saved by stop.
            vi.advanceTimersByTime(500);
            await harness.recorder.stop();

            const stored = await harness.store.load(id);

            expect(stored?.durationMs)
                .toBe(1734);
            expect(stored?.updatedAt)
                .toBe((stored?.createdAt ?? 0) + 1734);
        });
    });

    describe('listRecoverable', () => {
        it('lists stored recordings but not the one in progress', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'older' });
            await harness.recorder.start();
            const ids = (await harness.recorder.listRecoverable()).map(meta => meta.id);

            expect(ids)
                .toEqual(['older']);
        });

        it('lists a recording again once it has stopped', async () => {
            const harness = createHarness();

            await harness.recorder.start();
            lastOf(harness.recorders)
                .emitSlice(100);
            const finished = requireFinished(await harness.recorder.stop());
            const ids = (await harness.recorder.listRecoverable()).map(meta => meta.id);

            expect(ids)
                .toEqual([finished.id]);
        });

        it('returns an empty array when there is no store', async () => {
            const harness = createHarness({ store: null });

            await expect(harness.recorder.listRecoverable()).resolves.toEqual([]);
        });

        it('rejects when the store fails', async () => {
            const harness = createHarness();

            vi.spyOn(harness.store, 'list')
                .mockRejectedValue(new Error('database is gone'));

            await expect(harness.recorder.listRecoverable()).rejects.toThrow('database is gone');
        });
    });

    describe('continueRecording errors', () => {
        it('rejects while a recording is running, like start()', async () => {
            const harness = createHarness();

            await harness.recorder.start();

            await expect(harness.recorder.continueRecording('stored'))
                .rejects.toThrow('DurableRecorder is already recording');
        });

        it('needs the mergeSegments option', async () => {
            const harness = createHarness();
            const recorder = new DurableRecorder({ store: harness.store, monitors: [] });

            const reason = await captureRejection(recorder.continueRecording('stored'));

            expect(reason)
                .toMatchObject({
                    code: 'UNSUPPORTED',
                    message: 'continueRecording needs the mergeSegments option',
                });
        });

        it('needs a store', async () => {
            const harness = createHarness({ store: null });

            const reason = await captureRejection(harness.recorder.continueRecording('stored'));

            expect(reason)
                .toMatchObject({ code: 'UNSUPPORTED', message: 'continueRecording needs a store' });
        });

        it('rejects an unknown recording id with EMPTY', async () => {
            const harness = createHarness();

            const reason = await captureRejection(harness.recorder.continueRecording('missing'));

            expect(reason)
                .toMatchObject({ code: 'EMPTY', message: 'No stored recording with that id' });
            expect(harness.recorders)
                .toHaveLength(0);
            expect(harness.recorder.state)
                .toBe('idle');
        });

        it('rejects a stored video recording for an audio recorder before acquiring a stream', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'stored', source: 'video' });
            const reason = await captureRejection(harness.recorder.continueRecording('stored'));

            expect(reason)
                .toMatchObject({
                    code: 'UNSUPPORTED',
                    message: 'continueRecording needs a recorder with the same source as the stored recording',
                });
            expect(harness.devices.getUserMedia).not.toHaveBeenCalled();
            expect(harness.recorders)
                .toHaveLength(0);
            expect(harness.recorder.state)
                .toBe('idle');
        });

        it('continues a stored stream recording with the app MediaStream', async () => {
            const appStream = createFakeStream([new FakeMediaStreamTrack('audio')]);
            const harness = createHarness({ source: appStream });

            await seedRecording(harness.store, { id: 'stored', source: 'stream', segmentSizes: [2048] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            const finished = requireFinished(await harness.recorder.stop());

            expect(finished.id)
                .toBe('stored');
            expect(finished.segments)
                .toBe(2);
            expect(harness.devices.getUserMedia).not.toHaveBeenCalled();
        });

        it('rejects a stored type this browser cannot record', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'stored', mimeType: 'audio/ogg;codecs=vorbis' });
            const reason = await captureRejection(harness.recorder.continueRecording('stored'));

            expect(reason)
                .toMatchObject({ code: 'UNSUPPORTED' });
            expect(harness.recorders)
                .toHaveLength(0);
            expect(harness.recorder.state)
                .toBe('idle');
        });
    });

    describe('continued take', () => {
        it('writes the new take as the next segment and saves nextSegment + 1', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'stored', segmentSizes: [2048] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            const finished = requireFinished(await harness.recorder.stop());
            const stored = await harness.store.load('stored');

            expect(finished.id)
                .toBe('stored');
            expect(segmentSizes(stored))
                .toEqual([2048, 300]);
            expect(stored?.nextSegment)
                .toBe(2);
        });

        it('records with the stored mime type even when the picker prefers another', async () => {
            const harness = createHarness({}, [AUDIO_TYPE, 'audio/webm']);

            await seedRecording(harness.store, { id: 'stored', mimeType: 'audio/webm' });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            const finished = requireFinished(await harness.recorder.stop());

            expect(lastOf(harness.recorders).requestedOptions?.mimeType)
                .toBe('audio/webm');
            expect(finished.mimeType)
                .toBe('audio/webm');
        });

        it('keeps createdAt and metadata from the stored recording', async () => {
            const harness = createHarness({ metadata: { title: 'other' } });

            await seedRecording(harness.store, { id: 'stored', createdAt: 1000, metadata: { title: 'standup' } });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            const finished = requireFinished(await harness.recorder.stop());
            const stored = await harness.store.load('stored');

            expect(stored?.createdAt)
                .toBe(1000);
            expect(finished.metadata)
                .toEqual({ title: 'standup' });
        });

        it('saves the total duration of all takes on stop', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'stored', durationMs: 10000 });
            await harness.recorder.continueRecording('stored');
            vi.advanceTimersByTime(1500);
            lastOf(harness.recorders)
                .emitSlice(300);
            await harness.recorder.stop();

            expect((await harness.store.load('stored'))?.durationMs)
                .toBe(11500);
        });

        it('starts progress from the stored duration and size', async () => {
            const harness = createHarness();
            const onProgress = vi.fn<(progress: DurableRecorderEvents['progress']) => void>();

            harness.recorder.on('progress', onProgress);
            await seedRecording(harness.store, { id: 'stored', durationMs: 10000, segmentSizes: [1000, 500] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(100);

            expect(onProgress)
                .toHaveBeenLastCalledWith({ durationMs: 10000, sizeBytes: 1600 });

            await vi.advanceTimersByTimeAsync(1500);

            expect(onProgress)
                .toHaveBeenLastCalledWith({ durationMs: 11500, sizeBytes: 1600 });
        });

        it('counts the stored bytes toward maxBytes', async () => {
            const harness = createHarness({ maxBytes: 1000 });
            const onNear = vi.fn();
            const onLimit = vi.fn();

            harness.recorder.on('limit-near', onNear);
            harness.recorder.on('limit', onLimit);
            await seedRecording(harness.store, { id: 'stored', segmentSizes: [900] });
            await harness.recorder.continueRecording('stored');
            const mediaRecorder = lastOf(harness.recorders);

            mediaRecorder.emitSlice(50);

            expect(onNear)
                .toHaveBeenCalledWith({ kind: 'bytes', ratio: 0.95 });
            expect(onLimit).not.toHaveBeenCalled();

            mediaRecorder.emitSlice(50);

            expect(onLimit)
                .toHaveBeenCalledWith({ kind: 'bytes' });
            expect(mediaRecorder.stopCount)
                .toBe(1);
        });

        it('counts the stored duration toward maxDurationMs', async () => {
            const harness = createHarness({ maxDurationMs: 11000 });
            const onLimit = vi.fn();

            harness.recorder.on('limit', onLimit);
            await seedRecording(harness.store, { id: 'stored', durationMs: 10000 });
            await harness.recorder.continueRecording('stored');
            vi.advanceTimersByTime(1000);

            expect(onLimit)
                .toHaveBeenCalledWith({ kind: 'duration' });
            expect(lastOf(harness.recorders).stopCount)
                .toBe(1);
        });

        it('keeps the stored recording when cancel arrives during start', async () => {
            const harness = createHarness();
            let resolveStream: (stream: MediaStream) => void = () => undefined;
            const pendingStream = new Promise<MediaStream>((resolve) => {
                resolveStream = resolve;
            });

            const getUserMedia = vi.fn(() => pendingStream);

            await seedRecording(harness.store, { id: 'stored', segmentSizes: [2048] });
            vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

            const attempt = harness.recorder.continueRecording('stored')
                .catch((error: unknown) => error);

            // Cancel only after the microphone was requested, so the late stream is the one to release.
            await vi.waitFor(() => {
                expect(getUserMedia)
                    .toHaveBeenCalledTimes(1);
            });
            const cancelled = harness.recorder.cancel();

            resolveStream(harness.stream);
            await cancelled;
            await attempt;

            expect(harness.recorder.state)
                .toBe('idle');
            expect(harness.track.stopCount)
                .toBe(1);
            expect(segmentSizes(await harness.store.load('stored')))
                .toEqual([2048]);
        });
    });

    describe('FinishedRecording.segments', () => {
        it('is 1 for a recording that was not continued', async () => {
            const harness = createHarness();

            await harness.recorder.start();
            lastOf(harness.recorders)
                .emitSlice(300);
            const finished = requireFinished(await harness.recorder.stop());

            expect(finished.segments)
                .toBe(1);
        });

        it('counts the stored segments and the new take', async () => {
            const harness = createHarness();

            await seedRecording(harness.store, { id: 'stored', segmentSizes: [1000, 500] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            const finished = requireFinished(await harness.recorder.stop());

            expect(finished.segments)
                .toBe(3);
            expect(finished.blob.size)
                .toBe(1800);
            expect(segmentSizes(await harness.store.load('stored')))
                .toEqual([1000, 500, 300]);
        });
    });

    describe('new take under minRecordingBytes', () => {
        it('drops the new take, emits EMPTY and resolves with the stored recording', async () => {
            const harness = createHarness({ minRecordingBytes: 1024 });
            const onProblem = vi.fn<(payload: DurableRecorderEvents['problem']) => void>();

            harness.recorder.on('problem', onProblem);
            await seedRecording(harness.store, { id: 'stored', segmentSizes: [2048] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(100);
            const result = requireFinished(await harness.recorder.stop());

            expect(result.id)
                .toBe('stored');
            expect(result.sizeBytes)
                .toBe(2048);
            expect(result.segments)
                .toBe(1);
            expect(onProblem)
                .toHaveBeenCalledTimes(1);
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'EMPTY' }));
            expect(segmentSizes(await harness.store.load('stored')))
                .toEqual([2048]);
        });

        it('resolves null when the stored segments cannot be joined', async () => {
            const harness = createHarness({
                minRecordingBytes: 1024,
                mergeSegments: vi.fn<MergeSegments>(() => Promise.resolve(null)),
            });
            const onProblem = vi.fn<(payload: DurableRecorderEvents['problem']) => void>();

            harness.recorder.on('problem', onProblem);
            await seedRecording(harness.store, { id: 'stored', segmentSizes: [2048] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(100);

            expect(await harness.recorder.stop())
                .toBeNull();
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'EMPTY' }));
            expect(segmentSizes(await harness.store.load('stored')))
                .toEqual([2048]);
        });
    });

    describe('NOT_JOINED', () => {
        it('keeps both takes in the store and resolves with the new take only', async () => {
            const harness = createHarness({
                mergeSegments: vi.fn<MergeSegments>(() => Promise.resolve(null)),
            });
            const onProblem = vi.fn<(payload: DurableRecorderEvents['problem']) => void>();

            harness.recorder.on('problem', onProblem);
            await seedRecording(harness.store, { id: 'stored', segmentSizes: [2048] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            const result = requireFinished(await harness.recorder.stop());

            expect(result.segments)
                .toBe(1);
            expect(result.sizeBytes)
                .toBe(300);
            expect(onProblem)
                .toHaveBeenCalledTimes(1);
            expect(onProblem)
                .toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_JOINED' }));
            expect(segmentSizes(await harness.store.load('stored')))
                .toEqual([2048, 300]);
        });
    });

    describe('cancel of a continued take', () => {
        it('drops only the new segment and keeps the stored recording', async () => {
            const harness = createHarness();
            const onFinish = vi.fn<(payload: FinishedRecording) => void>();
            const onProblem = vi.fn<(payload: DurableRecorderEvents['problem']) => void>();

            harness.recorder.on('finish', onFinish);
            harness.recorder.on('problem', onProblem);
            await seedRecording(harness.store, { id: 'stored', segmentSizes: [2048] });
            await harness.recorder.continueRecording('stored');
            lastOf(harness.recorders)
                .emitSlice(300);
            await harness.recorder.cancel();

            expect(onFinish).not.toHaveBeenCalled();
            expect(onProblem).not.toHaveBeenCalled();
            expect(segmentSizes(await harness.store.load('stored')))
                .toEqual([2048]);
        });
    });
});
