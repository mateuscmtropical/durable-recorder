import { RecorderError, isRecorderError } from '../errors/RecorderError';
import type { RecorderProblemCode } from '../errors/RecorderError';
import { classifyStartError } from '../errors/classifyStartError';
import { createInterruptionMonitor, createSilenceMonitor, createWakeLockMonitor } from '../monitors';
import type { MonitorContext, MonitorFactory, RecordingMonitor } from '../monitors/RecordingMonitor';
import { acquireStream, extensionForMimeType, isRecordingSupported, pickMimeType, releaseStream, streamHasVideo } from '../sources';
import type { AcquiredStream, RecordingSource, StreamRequest } from '../sources/sourceTypes';
import { createRecordingId } from '../shared/createRecordingId';
import { TypedEventEmitter } from '../shared/TypedEventEmitter';
import { RecordingStore } from '../storage/RecordingStore';
import type { RecordingMeta, RecordingSourceKind, RecordingStoreOptions, StoredRecording } from '../storage/storageTypes';
import { createLimitTracker, isLimitReached, limitRatio } from './limitTracker';
import type { LimitTracker, LimitTrackerOptions } from './limitTracker';
import type {
    DurableRecorderEvents,
    DurableRecorderOptions,
    FinishedRecording,
    LimitAction,
    RecorderProgress,
    RecorderState,
} from './recorderTypes';

const DEFAULT_SOURCE: RecordingSource = 'audio';
const DEFAULT_TIMESLICE_MS = 500;
const DEFAULT_WARN_AT = 0.9;
const DEFAULT_MIN_RECORDING_BYTES = 1024;
const PROGRESS_INTERVAL_MS = 250;
const STOP_EVENT_TIMEOUT_MS = 2000;
const DEFAULT_AUDIO_MIME_TYPE = 'audio/webm';
const DEFAULT_VIDEO_MIME_TYPE = 'video/webm';
const ALREADY_RECORDING_MESSAGE = 'DurableRecorder is already recording';
const START_CANCELLED_MESSAGE = 'Recording was cancelled before it started.';
const RETENTION_RANGE_MESSAGE = 'retentionDays must be a number of days, 0 or more';
const CONTINUE_NEEDS_MERGE_MESSAGE = 'continueRecording needs the mergeSegments option';
const CONTINUE_NEEDS_STORE_MESSAGE = 'continueRecording needs a store';
const MISSING_RECORDING_MESSAGE = 'No stored recording with that id';
const CONTINUE_SOURCE_MISMATCH_MESSAGE = 'continueRecording needs a recorder with the same source as the stored recording';

type StoreWrite = (store: RecordingStore) => Promise<void>;

interface RecorderSettings {
    source: RecordingSource;
    request: StreamRequest;
    mimeType: string | undefined;
    timeslice: number;
    audioBitsPerSecond: number | undefined;
    videoBitsPerSecond: number | undefined;
    limits: LimitTrackerOptions;
    onLimit: LimitAction;
    metadata: Record<string, unknown>;
    store: RecordingStore | null;
    minRecordingBytes: number;
    monitors: MonitorFactory[];
    finalize: DurableRecorderOptions['finalize'];
    mergeSegments: DurableRecorderOptions['mergeSegments'];
}

interface SessionInput {
    id: string;
    acquired: AcquiredStream;
    mediaRecorder: MediaRecorder;
    mimeType: string;
    startedAt: number;
    settings: RecorderSettings;
    previous: StoredRecording | null;
    segment: number;
    baseDurationMs: number;
}

// One recording from start to finish. Only DurableRecorder changes its fields.
interface RecordingSession {
    id: string;
    acquired: AcquiredStream;
    mediaRecorder: MediaRecorder;
    mimeType: string;
    meta: RecordingMeta;
    store: RecordingStore | null;
    startedAt: number;
    stopped: Promise<void>;
    limits: LimitTracker;
    slices: Blob[];
    sizeBytes: number;
    nextPosition: number;
    writes: Promise<void>;
    monitors: RecordingMonitor[];
    progressTimer?: ReturnType<typeof setInterval>;
    isStorageOff: boolean;
    hasProblem: boolean;
    isEnding: boolean;
    isDiscarded: boolean;
    isClosed: boolean;
    previous: StoredRecording | null;
    segment: number;
    baseDurationMs: number;
    pausedAt: number | null; // set while the take is paused
    pausedTotalMs: number; // time paused in earlier pauses of this take
}

// Silence only matters for voice recordings. A quiet video or screen capture is normal.
function createDefaultMonitors(source: RecordingSource): MonitorFactory[] {
    const monitors = [createInterruptionMonitor(), createWakeLockMonitor()];

    if (source !== 'audio') {
        return monitors;
    }

    const silenceMonitor = createSilenceMonitor();

    return [...monitors, silenceMonitor];
}

function assertRetentionDays(retentionDays: number | undefined): void {
    if (retentionDays === undefined) {
        return;
    }

    if (Number.isNaN(retentionDays) || retentionDays < 0) {
        throw new RangeError(RETENTION_RANGE_MESSAGE);
    }
}

function assertRecordingSupported(source: RecordingSource): void {
    if (!isRecordingSupported(source)) {
        throw new RecorderError('UNSUPPORTED');
    }
}

// A MediaStream from the app is stored as 'stream'. The other sources are stored as their own name.
function sourceKindOf(source: RecordingSource): RecordingSourceKind {
    return typeof source === 'string' ? source : 'stream';
}

// A continued take must use the mime type the recording was stored with.
function assertMimeTypeSupported(previous: StoredRecording | null): void {
    if (previous && !MediaRecorder.isTypeSupported(previous.mimeType)) {
        throw new RecorderError('UNSUPPORTED');
    }
}

// retentionDays is left out when not set, because exactOptionalPropertyTypes is on.
function buildStoreOptions(retentionDays: number | undefined): RecordingStoreOptions {
    const storeOptions: RecordingStoreOptions = {};

    if (retentionDays !== undefined) {
        storeOptions.retentionDays = retentionDays;
    }

    return storeOptions;
}

function resolveStore(store: RecordingStore | null | undefined, retentionDays: number | undefined): RecordingStore | null {
    if (store === undefined) {
        const storeOptions = buildStoreOptions(retentionDays);

        return new RecordingStore(storeOptions);
    }

    return store;
}

// Only the options the caller set are passed on. The rest keep the acquireStream defaults.
function buildStreamRequest(options: DurableRecorderOptions, source: RecordingSource): StreamRequest {
    const request: StreamRequest = { source };

    if (options.audio !== undefined) {
        request.audio = options.audio;
    }

    if (options.video !== undefined) {
        request.video = options.video;
    }

    return request;
}

function resolveSettings(options: DurableRecorderOptions): RecorderSettings {
    const source = options.source ?? DEFAULT_SOURCE;

    return {
        source,
        request: buildStreamRequest(options, source),
        mimeType: options.mimeType,
        timeslice: options.timeslice ?? DEFAULT_TIMESLICE_MS,
        audioBitsPerSecond: options.audioBitsPerSecond,
        videoBitsPerSecond: options.videoBitsPerSecond,
        limits: {
            maxBytes: options.maxBytes,
            maxDurationMs: options.maxDurationMs,
            warnAt: options.warnAt ?? DEFAULT_WARN_AT,
        },
        onLimit: options.onLimit ?? 'stop',
        metadata: options.metadata ?? {},
        store: resolveStore(options.store, options.retentionDays),
        minRecordingBytes: options.minRecordingBytes ?? DEFAULT_MIN_RECORDING_BYTES,
        monitors: options.monitors ?? createDefaultMonitors(source),
        finalize: options.finalize,
        mergeSegments: options.mergeSegments,
    };
}

// The options are left out when they are not set, because exactOptionalPropertyTypes is on.
function buildRecorderOptions(settings: RecorderSettings, mimeType: string | undefined): MediaRecorderOptions {
    const recorderOptions: MediaRecorderOptions = {};

    if (mimeType !== undefined) {
        recorderOptions.mimeType = mimeType;
    }

    if (settings.audioBitsPerSecond !== undefined) {
        recorderOptions.audioBitsPerSecond = settings.audioBitsPerSecond;
    }

    if (settings.videoBitsPerSecond !== undefined) {
        recorderOptions.videoBitsPerSecond = settings.videoBitsPerSecond;
    }

    return recorderOptions;
}

// The browser can report an empty type. Then the picked type, then a default, is used.
function resolveRecordedType(recorderType: string | undefined, pickedType: string | undefined, hasVideo: boolean): string {
    if (recorderType) {
        return recorderType;
    }

    if (pickedType) {
        return pickedType;
    }

    return hasVideo ? DEFAULT_VIDEO_MIME_TYPE : DEFAULT_AUDIO_MIME_TYPE;
}

// A continued take keeps the stored identity and gets the next segment number.
function buildMeta(input: SessionInput): RecordingMeta {
    const previous = input.previous;

    return {
        id: input.id,
        mimeType: input.mimeType,
        source: previous ? previous.source : input.acquired.kind,
        createdAt: previous ? previous.createdAt : input.startedAt,
        updatedAt: input.startedAt,
        metadata: previous ? previous.metadata : input.settings.metadata,
        nextSegment: input.segment + 1,
        durationMs: input.baseDurationMs,
    };
}

function waitForStop(mediaRecorder: MediaRecorder): Promise<void> {
    return new Promise<void>((resolve) => {
        mediaRecorder.addEventListener('stop', () => {
            resolve();
        }, { once: true });
    });
}

// The stop event normally arrives first. The timeout covers a recorder that never fires it.
function waitForStopOrTimeout(stopped: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            resolve();
        }, STOP_EVENT_TIMEOUT_MS);
    });

    return Promise.race([stopped, timeout])
        .finally(() => {
            clearTimeout(timer);
        });
}

function sumBlobSizes(blobs: Blob[]): number {
    return blobs.reduce((total, blob) => total + blob.size, 0);
}

function createSession(input: SessionInput): RecordingSession {
    const carriedBytes = sumBlobSizes(input.previous ? input.previous.segments : []);

    return {
        id: input.id,
        acquired: input.acquired,
        mediaRecorder: input.mediaRecorder,
        mimeType: input.mimeType,
        meta: buildMeta(input),
        store: input.settings.store,
        startedAt: input.startedAt,
        stopped: waitForStop(input.mediaRecorder),
        limits: createLimitTracker(input.settings.limits),
        slices: [],
        sizeBytes: carriedBytes,
        nextPosition: 0,
        writes: Promise.resolve(),
        monitors: [],
        isStorageOff: false,
        hasProblem: false,
        isEnding: false,
        isDiscarded: false,
        isClosed: false,
        previous: input.previous,
        segment: input.segment,
        baseDurationMs: input.baseDurationMs,
        pausedAt: null,
        pausedTotalMs: 0,
    };
}

// Time of this take without the time it was paused. A paused take counts up to the pause.
function takeDurationMs(session: RecordingSession): number {
    const activeUntil = session.pausedAt ?? Date.now();

    return activeUntil - session.startedAt - session.pausedTotalMs;
}

// Stored time of the earlier takes plus the time of this take.
function totalDurationMs(session: RecordingSession): number {
    return session.baseDurationMs + takeDurationMs(session);
}

function readProgress(session: RecordingSession): RecorderProgress {
    return {
        durationMs: totalDurationMs(session),
        sizeBytes: session.sizeBytes,
    };
}

// The browser reports a full disk as a QuotaExceededError.
function isQuotaError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'QuotaExceededError';
}

function toStartError(error: unknown): RecorderError {
    if (isRecorderError(error)) {
        return error;
    }

    const code = classifyStartError(error);

    return new RecorderError(code, undefined, { cause: error });
}

// stop() throws when the recorder already stopped by itself, for example after an error.
// The stop event or the timeout still ends the wait, so the throw is dropped.
function stopRecorder(mediaRecorder: MediaRecorder): void {
    try {
        mediaRecorder.stop();
    } catch {
        // Dropped on purpose, see above.
    }
}

// One monitor that fails to release must not keep the others running.
function releaseMonitors(monitors: RecordingMonitor[]): void {
    monitors.forEach((monitor) => {
        try {
            monitor.release();
        } catch {
            // Dropped on purpose, see above.
        }
    });
}

async function writeSlice(store: RecordingStore, session: RecordingSession, position: number, blob: Blob): Promise<void> {
    const data = await blob.arrayBuffer();

    await store.appendChunk({ recordingId: session.id, segment: session.segment, position, data });
}

function buildSnapshot(session: RecordingSession, durationMs: number): RecordingMeta {
    return {
        ...session.meta,
        updatedAt: Date.now(),
        durationMs,
    };
}

async function saveSnapshot(store: RecordingStore, session: RecordingSession, durationMs: number): Promise<void> {
    const snapshot = buildSnapshot(session, durationMs);

    await store.saveMeta(snapshot);
}

// Puts the stored meta back after this take is dropped, so the next take reuses its segment number.
function buildRollbackMeta(session: RecordingSession): RecordingMeta {
    return {
        ...session.meta,
        nextSegment: session.segment,
        durationMs: session.baseDurationMs,
        updatedAt: Date.now(),
    };
}

// Only this take goes. The stored segments before it stay.
async function dropTake(store: RecordingStore, session: RecordingSession): Promise<void> {
    await store
        .dropSegments(session.id, session.segment)
        .catch(() => undefined);

    const rollback = buildRollbackMeta(session);

    await store
        .saveMeta(rollback)
        .catch(() => undefined);
}

// A new recording is deleted. A continued one keeps its stored segments.
// Errors from the store are ignored, because the take is already over.
async function removeTake(store: RecordingStore | null, session: RecordingSession): Promise<void> {
    if (!store) {
        return;
    }

    if (session.previous) {
        await dropTake(store, session);

        return;
    }

    await store
        .delete(session.id)
        .catch(() => undefined);
}

// A join that throws counts as a failed join.
async function joinSegments(
    merge: DurableRecorderOptions['mergeSegments'],
    segments: Blob[],
    mimeType: string,
): Promise<Blob | null> {
    if (!merge) {
        return null;
    }

    try {
        return await merge(segments, mimeType);
    } catch {
        return null;
    }
}

function buildFinished(session: RecordingSession, blob: Blob, segments: number, durationMs: number): FinishedRecording {
    return {
        id: session.id,
        blob,
        mimeType: session.mimeType,
        extension: extensionForMimeType(session.mimeType),
        durationMs,
        sizeBytes: blob.size,
        metadata: session.meta.metadata,
        segments,
    };
}

/**
 * Records audio, video or the screen. Every slice goes to IndexedDB as it arrives,
 * so a recording survives a crash up to the last slice.
 */
class DurableRecorder extends TypedEventEmitter<DurableRecorderEvents> {
    private readonly settings: RecorderSettings;
    private currentState: RecorderState = 'idle';
    private session: RecordingSession | null = null;
    private stopPromise: Promise<FinishedRecording | null> | null = null;
    private attempt: Promise<void> | null = null;
    private isCancelRequested = false;
    private hasPruned = false;

    constructor(options: DurableRecorderOptions = {}) {
        super();

        assertRetentionDays(options.retentionDays);
        this.settings = resolveSettings(options);
    }

    static isSupported(source?: RecordingSource): boolean {
        return isRecordingSupported(source);
    }

    get state(): RecorderState {
        return this.currentState;
    }

    // The id of the current recording. Null when idle.
    get recordingId(): string | null {
        return this.session?.id ?? null;
    }

    get progress(): RecorderProgress {
        const session = this.session;

        if (!session) {
            return { durationMs: 0, sizeBytes: 0 };
        }

        return readProgress(session);
    }

    /**
     * Asks for the source, starts MediaRecorder and resolves once it records.
     */
    start(): Promise<void> {
        return this.begin(null);
    }

    /**
     * Records a new take into a stored recording. The take gets the next segment number.
     * Needs the mergeSegments option and a store.
     */
    continueRecording(recordingId: string): Promise<void> {
        return this.begin(recordingId);
    }

    /**
     * Stored recordings except the one being written now. Expired ones are pruned first.
     */
    async listRecoverable(): Promise<RecordingMeta[]> {
        const store = this.settings.store;

        if (!store) {
            return [];
        }

        this.prepareStore();

        const metas = await store.list();
        const activeId = this.recordingId;

        return metas.filter(meta => meta.id !== activeId);
    }

    /**
     * Stops the recording and resolves with the finished file, or null when there is nothing to keep.
     * The stored recording stays in the store. Call store.delete(id) when the app no longer needs it.
     */
    stop(): Promise<FinishedRecording | null> {
        if (this.currentState === 'starting') {
            return this.waitForAttempt()
                .then(() => this.requestStop(false));
        }

        return this.requestStop(false);
    }

    /**
     * Stops the recording and drops it. The stored copy is deleted and no finish event is sent.
     * For a continued recording only the new take is dropped.
     */
    cancel(): Promise<void> {
        if (this.currentState === 'starting') {
            this.isCancelRequested = true;

            return this.waitForAttempt();
        }

        return this.requestStop(true)
            .then(() => undefined);
    }

    /**
     * Pauses the recording. Paused time does not count toward the duration or the limits.
     * Does nothing unless the recorder is recording.
     */
    pause(): void {
        if (this.session) {
            this.pauseTake(this.session);
        }
    }

    /**
     * Resumes a paused recording. With onLimit 'pause', it does nothing while a limit is reached.
     * Stop the recording instead.
     */
    resume(): void {
        const session = this.session;

        if (!session || this.currentState !== 'paused') {
            return;
        }

        const progress = readProgress(session);

        if (this.settings.onLimit === 'pause' && isLimitReached(this.settings.limits, progress)) {
            return;
        }

        this.resumeTake(session);
    }

    private begin(continuedId: string | null): Promise<void> {
        if (this.currentState !== 'idle') {
            return Promise.reject(new Error(ALREADY_RECORDING_MESSAGE));
        }

        this.prepareStore();
        this.isCancelRequested = false;
        this.setState('starting');
        this.attempt = this.runStart(continuedId);

        return this.attempt;
    }

    private waitForAttempt(): Promise<void> {
        if (!this.attempt) {
            return Promise.resolve();
        }

        return this.attempt.catch(() => undefined);
    }

    // Pruning runs once, before the first store operation of this recorder. The store runs
    // its operations in order, so the prune finishes before any write of the new take.
    private prepareStore(): void {
        const store = this.settings.store;

        if (!store || this.hasPruned) {
            return;
        }

        this.hasPruned = true;

        const pruning = store.pruneExpired();

        // A failed prune must not block recording.
        void pruning.catch(() => undefined);
    }

    private async runStart(continuedId: string | null): Promise<void> {
        let acquired: AcquiredStream | undefined;

        try {
            const previous = await this.loadPrevious(continuedId);

            assertRecordingSupported(this.settings.source);
            assertMimeTypeSupported(previous);
            acquired = await acquireStream(this.settings.request);
            this.assertNotCancelled();
            this.beginRecording(acquired, previous);
        } catch (error: unknown) {
            if (acquired) {
                releaseStream(acquired);
            }

            this.setState('idle');

            throw this.isCancelRequested ? new Error(START_CANCELLED_MESSAGE) : toStartError(error);
        }
    }

    private assertNotCancelled(): void {
        if (this.isCancelRequested) {
            throw new Error(START_CANCELLED_MESSAGE);
        }
    }

    private async loadPrevious(continuedId: string | null): Promise<StoredRecording | null> {
        if (continuedId === null) {
            return null;
        }

        if (!this.settings.mergeSegments) {
            throw new RecorderError('UNSUPPORTED', CONTINUE_NEEDS_MERGE_MESSAGE);
        }

        const store = this.settings.store;

        if (!store) {
            throw new RecorderError('UNSUPPORTED', CONTINUE_NEEDS_STORE_MESSAGE);
        }

        const stored = await store.load(continuedId);

        if (!stored) {
            throw new RecorderError('EMPTY', MISSING_RECORDING_MESSAGE);
        }

        if (stored.source !== sourceKindOf(this.settings.source)) {
            throw new RecorderError('UNSUPPORTED', CONTINUE_SOURCE_MISMATCH_MESSAGE);
        }

        return stored;
    }

    private beginRecording(acquired: AcquiredStream, previous: StoredRecording | null): void {
        const hasVideo = streamHasVideo(acquired.stream);
        const pickedType = previous ? previous.mimeType : pickMimeType(hasVideo, this.settings.mimeType);
        const recorderOptions = buildRecorderOptions(this.settings, pickedType);
        const mediaRecorder = new MediaRecorder(acquired.stream, recorderOptions);
        const mimeType = previous ? previous.mimeType : resolveRecordedType(mediaRecorder.mimeType, pickedType, hasVideo);
        const id = previous ? previous.id : createRecordingId();
        const segment = previous ? previous.nextSegment : 0;
        const baseDurationMs = previous?.durationMs ?? 0;
        const session = createSession({
            id,
            acquired,
            mediaRecorder,
            mimeType,
            startedAt: Date.now(),
            settings: this.settings,
            previous,
            segment,
            baseDurationMs,
        });

        this.attachRecorderListeners(session);
        session.monitors = this.startMonitors(session);
        this.startRecorder(session);
        this.activate(session);
    }

    private attachRecorderListeners(session: RecordingSession): void {
        session.mediaRecorder.addEventListener('dataavailable', (event) => {
            this.handleSlice(session, event.data);
        });
        session.mediaRecorder.addEventListener('error', (event) => {
            if (this.isActive(session)) {
                const code = classifyStartError(event.error);

                this.handleProblem(session, code, event.error);
            }
        });
    }

    // Monitors are created before the recorder starts, so a report during creation is dropped.
    private startMonitors(session: RecordingSession): RecordingMonitor[] {
        const context: MonitorContext = {
            stream: session.acquired.stream,
            reportProblem: (code) => {
                if (this.isActive(session)) {
                    this.handleProblem(session, code);
                }
            },
            warnSilence: (secondsLeft) => {
                if (this.isActive(session)) {
                    this.emit('silence', { secondsLeft });
                }
            },
        };

        const monitors: RecordingMonitor[] = [];

        try {
            this.settings.monitors.forEach((factory) => {
                const monitor = factory(context);

                monitors.push(monitor);
            });
        } catch (error: unknown) {
            releaseMonitors(monitors);
            throw error;
        }

        return monitors;
    }

    private startRecorder(session: RecordingSession): void {
        try {
            session.mediaRecorder.start(this.settings.timeslice);
        } catch (error: unknown) {
            releaseMonitors(session.monitors);
            throw error;
        }
    }

    private activate(session: RecordingSession): void {
        this.session = session;
        this.enqueueWrite(session, store => store.saveMeta(session.meta));
        this.setState('recording');
        session.progressTimer = setInterval(() => {
            this.publishProgress(session);
        }, PROGRESS_INTERVAL_MS);
    }

    private handleSlice(session: RecordingSession, blob: Blob): void {
        // Slices after the close are late. Writing them now would leave chunks of a finished recording.
        if (blob.size === 0 || session.isClosed) {
            return;
        }

        const position = session.nextPosition;
        // Taken now, so the stored duration covers this slice even if the write runs later.
        const durationMs = totalDurationMs(session);

        session.nextPosition += 1;
        session.slices.push(blob);
        session.sizeBytes += blob.size;
        session.monitors.forEach((monitor) => {
            monitor.noteData();
        });
        this.enqueueWrite(session, store => writeSlice(store, session, position, blob));
        this.enqueueWrite(session, store => saveSnapshot(store, session, durationMs));
        this.publishProgress(session);
    }

    private publishProgress(session: RecordingSession): void {
        if (session.isEnding) {
            return;
        }

        const progress = readProgress(session);

        this.emit('progress', progress);
        this.checkLimits(session, progress);
    }

    // The byte limit can overshoot by one slice, because the check runs after a slice is added.
    private checkLimits(session: RecordingSession, progress: RecorderProgress): void {
        const check = session.limits.check(progress);

        check.near.forEach((kind) => {
            const ratio = limitRatio(this.settings.limits, progress, kind);

            this.emit('limit-near', { kind, ratio });
        });
        check.reached.forEach((kind) => {
            this.emit('limit', { kind });
        });

        if (check.reached.length > 0 && this.settings.onLimit === 'stop') {
            void this.requestStop(false);
        }

        if (check.reached.length > 0 && this.settings.onLimit === 'pause') {
            this.pauseTake(session);
        }
    }

    // A problem is emitted once per recording. Only the first one stops the recording.
    private handleProblem(session: RecordingSession, code: RecorderProblemCode, cause?: unknown): void {
        if (session.hasProblem) {
            return;
        }

        this.emitProblem(session, code, cause);

        if (!session.isEnding) {
            void this.requestStop(false);
        }
    }

    private emitProblem(session: RecordingSession, code: RecorderProblemCode, cause?: unknown): void {
        const error = new RecorderError(code, undefined, { cause });

        session.hasProblem = true;
        this.emit('problem', { code, error });
    }

    // Only the first problem is emitted. A later one is dropped.
    private emitFirstProblem(session: RecordingSession, code: RecorderProblemCode): void {
        if (!session.hasProblem) {
            this.emitProblem(session, code);
        }
    }

    private enqueueWrite(session: RecordingSession, write: StoreWrite): void {
        session.writes = session.writes.then(() => this.runWrite(session, write));
    }

    // Writes run one after another. Errors are handled here, so the chain never rejects.
    private async runWrite(session: RecordingSession, write: StoreWrite): Promise<void> {
        const store = session.store;

        if (!store || session.isStorageOff) {
            return;
        }

        try {
            await write(store);
        } catch (error: unknown) {
            this.handleStorageError(session, error);
        }
    }

    // After a failed write the recording continues in memory, with no more writes to the store.
    private handleStorageError(session: RecordingSession, error: unknown): void {
        session.isStorageOff = true;

        if (isQuotaError(error)) {
            this.handleProblem(session, 'STORAGE_FULL', error);

            return;
        }

        this.emit('storage-error', { error });
    }

    // Only a recording can pause. Monitors pause with the recorder, so they do not report silence or no data.
    private pauseTake(session: RecordingSession): void {
        if (this.currentState !== 'recording') {
            return;
        }

        try {
            session.mediaRecorder.pause();
        } catch {
            // pause() throws once the recorder has stopped. The stop or error that follows ends the take.
            return;
        }

        session.pausedAt = Date.now();
        session.monitors.forEach((monitor) => {
            monitor.pause();
        });

        const durationMs = totalDurationMs(session);

        this.enqueueWrite(session, store => saveSnapshot(store, session, durationMs));
        this.setState('paused');
    }

    private resumeTake(session: RecordingSession): void {
        const pausedAt = session.pausedAt;

        if (pausedAt === null) {
            return;
        }

        try {
            session.mediaRecorder.resume();
        } catch {
            // resume() throws once the recorder has stopped. The stop or error that follows ends the take.
            return;
        }

        session.pausedTotalMs += Date.now() - pausedAt;
        session.pausedAt = null;
        session.monitors.forEach((monitor) => {
            monitor.resume();
        });
        this.setState('recording');
    }

    private isActive(session: RecordingSession): boolean {
        return this.session === session && !session.isEnding;
    }

    private setState(state: RecorderState): void {
        this.currentState = state;
        this.emit('state', { state });
    }

    private goIdle(): void {
        this.session = null;
        this.stopPromise = null;
        this.setState('idle');
    }

    private requestStop(discard: boolean): Promise<FinishedRecording | null> {
        const session = this.session;

        if (!session) {
            return Promise.resolve(null);
        }

        if (discard) {
            session.isDiscarded = true;
        }

        if (session.isEnding) {
            return this.stopPromise ?? Promise.resolve(null);
        }

        session.isEnding = true;
        this.setState('stopping');
        this.stopPromise = this.endRecording(session);

        return this.stopPromise;
    }

    private async endRecording(session: RecordingSession): Promise<FinishedRecording | null> {
        try {
            await this.closeCapture(session);

            return await this.concludeRecording(session);
        } catch {
            // Nothing above should throw. If it does, reset so the recorder never stays in 'stopping'.
            if (this.session === session) {
                this.goIdle();
            }

            return null;
        }
    }

    // Ends the MediaRecorder and the capture, then waits for the pending writes.
    private async closeCapture(session: RecordingSession): Promise<void> {
        clearInterval(session.progressTimer);
        stopRecorder(session.mediaRecorder);
        await waitForStopOrTimeout(session.stopped);
        session.isClosed = true;
        releaseMonitors(session.monitors);
        releaseStream(session.acquired);

        if (!session.isDiscarded) {
            const durationMs = totalDurationMs(session);

            this.enqueueWrite(session, store => saveSnapshot(store, session, durationMs));
        }

        await session.writes;
    }

    private async concludeRecording(session: RecordingSession): Promise<FinishedRecording | null> {
        if (session.isDiscarded) {
            await removeTake(session.store, session);
            this.goIdle();

            return null;
        }

        const take = new Blob(session.slices, { type: session.mimeType });

        if (take.size < this.settings.minRecordingBytes) {
            this.emitFirstProblem(session, 'EMPTY');
            await removeTake(session.store, session);

            return this.resolvePrevious(session);
        }

        return this.resolveTake(session, take);
    }

    // A new take that is too short leaves the stored recording as it was.
    private async resolvePrevious(session: RecordingSession): Promise<FinishedRecording | null> {
        const previous = session.previous;

        if (!previous) {
            this.goIdle();

            return null;
        }

        const joined = await joinSegments(this.settings.mergeSegments, previous.segments, session.mimeType);

        if (!joined) {
            this.goIdle();

            return null;
        }

        return this.completeRecording(session, joined, previous.segments.length, session.baseDurationMs);
    }

    private async resolveTake(session: RecordingSession, take: Blob): Promise<FinishedRecording> {
        const previous = session.previous;

        if (!previous) {
            const durationMs = totalDurationMs(session);

            return this.completeRecording(session, take, 1, durationMs);
        }

        const allSegments = [...previous.segments, take];
        const joined = await joinSegments(this.settings.mergeSegments, allSegments, session.mimeType);

        if (joined) {
            const durationMs = totalDurationMs(session);

            return this.completeRecording(session, joined, allSegments.length, durationMs);
        }

        // The store still has every segment, so the app can load them later.
        this.emitFirstProblem(session, 'NOT_JOINED');

        const takeOnlyMs = takeDurationMs(session);

        return this.completeRecording(session, take, 1, takeOnlyMs);
    }

    // Shared end of every finished result: finalize, go idle, then announce it.
    private async completeRecording(
        session: RecordingSession,
        blob: Blob,
        segments: number,
        durationMs: number,
    ): Promise<FinishedRecording> {
        const finalBlob = await this.finalizeBlob(blob, session.mimeType);
        const finished = buildFinished(session, finalBlob, segments, durationMs);

        this.goIdle();
        this.emit('finish', finished);

        return finished;
    }

    // A failed finalize keeps the original blob.
    private async finalizeBlob(blob: Blob, mimeType: string): Promise<Blob> {
        const finalize = this.settings.finalize;

        if (!finalize) {
            return blob;
        }

        try {
            return await finalize(blob, mimeType);
        } catch {
            return blob;
        }
    }
}

export { DurableRecorder, createDefaultMonitors };
