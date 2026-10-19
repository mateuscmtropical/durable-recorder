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
import type { RecordingMeta } from '../storage/storageTypes';
import { createLimitTracker, limitRatio } from './limitTracker';
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
}

interface SessionInput {
    id: string;
    acquired: AcquiredStream;
    mediaRecorder: MediaRecorder;
    mimeType: string;
    startedAt: number;
    settings: RecorderSettings;
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

function assertRecordingSupported(source: RecordingSource): void {
    if (!isRecordingSupported(source)) {
        throw new RecorderError('UNSUPPORTED');
    }
}

function resolveStore(store: RecordingStore | null | undefined): RecordingStore | null {
    if (store === undefined) {
        return new RecordingStore();
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
        store: resolveStore(options.store),
        minRecordingBytes: options.minRecordingBytes ?? DEFAULT_MIN_RECORDING_BYTES,
        monitors: options.monitors ?? createDefaultMonitors(source),
        finalize: options.finalize,
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

function buildMeta(input: SessionInput): RecordingMeta {
    return {
        id: input.id,
        mimeType: input.mimeType,
        source: input.acquired.kind,
        createdAt: input.startedAt,
        updatedAt: input.startedAt,
        metadata: input.settings.metadata,
        nextSegment: 1,
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

function createSession(input: SessionInput): RecordingSession {
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
        sizeBytes: 0,
        nextPosition: 0,
        writes: Promise.resolve(),
        monitors: [],
        isStorageOff: false,
        hasProblem: false,
        isEnding: false,
        isDiscarded: false,
        isClosed: false,
    };
}

function readProgress(session: RecordingSession): RecorderProgress {
    return {
        durationMs: Date.now() - session.startedAt,
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

async function writeSlice(store: RecordingStore, recordingId: string, position: number, blob: Blob): Promise<void> {
    const data = await blob.arrayBuffer();

    await store.appendChunk({ recordingId, segment: 0, position, data });
}

// Errors from the delete are ignored, because the recording is already over.
async function removeStored(store: RecordingStore | null, recordingId: string): Promise<void> {
    if (!store) {
        return;
    }

    await store
        .delete(recordingId)
        .catch(() => undefined);
}

function buildFinished(session: RecordingSession, blob: Blob): FinishedRecording {
    return {
        id: session.id,
        blob,
        mimeType: session.mimeType,
        extension: extensionForMimeType(session.mimeType),
        durationMs: Date.now() - session.startedAt,
        sizeBytes: blob.size,
        metadata: session.meta.metadata,
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

    constructor(options: DurableRecorderOptions = {}) {
        super();

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
        if (this.currentState !== 'idle') {
            return Promise.reject(new Error(ALREADY_RECORDING_MESSAGE));
        }

        this.isCancelRequested = false;
        this.setState('starting');
        this.attempt = this.runStart();

        return this.attempt;
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
     */
    cancel(): Promise<void> {
        if (this.currentState === 'starting') {
            this.isCancelRequested = true;

            return this.waitForAttempt();
        }

        return this.requestStop(true)
            .then(() => undefined);
    }

    private waitForAttempt(): Promise<void> {
        if (!this.attempt) {
            return Promise.resolve();
        }

        return this.attempt.catch(() => undefined);
    }

    private async runStart(): Promise<void> {
        let acquired: AcquiredStream | undefined;

        try {
            assertRecordingSupported(this.settings.source);
            acquired = await acquireStream(this.settings.request);

            if (this.isCancelRequested) {
                throw new Error(START_CANCELLED_MESSAGE);
            }

            this.beginRecording(acquired);
        } catch (error: unknown) {
            if (acquired) {
                releaseStream(acquired);
            }

            this.setState('idle');

            throw this.isCancelRequested ? new Error(START_CANCELLED_MESSAGE) : toStartError(error);
        }
    }

    private beginRecording(acquired: AcquiredStream): void {
        const hasVideo = streamHasVideo(acquired.stream);
        const pickedType = pickMimeType(hasVideo, this.settings.mimeType);
        const recorderOptions = buildRecorderOptions(this.settings, pickedType);
        const mediaRecorder = new MediaRecorder(acquired.stream, recorderOptions);
        const mimeType = resolveRecordedType(mediaRecorder.mimeType, pickedType, hasVideo);
        const id = createRecordingId();
        const session = createSession({
            id,
            acquired,
            mediaRecorder,
            mimeType,
            startedAt: Date.now(),
            settings: this.settings,
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

        session.nextPosition += 1;
        session.slices.push(blob);
        session.sizeBytes += blob.size;
        session.monitors.forEach((monitor) => {
            monitor.noteData();
        });
        this.enqueueWrite(session, store => writeSlice(store, session.id, position, blob));
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
            const updatedAt = Date.now();

            this.enqueueWrite(session, store => store.saveMeta({ ...session.meta, updatedAt }));
        }

        await session.writes;
    }

    private async concludeRecording(session: RecordingSession): Promise<FinishedRecording | null> {
        if (session.isDiscarded) {
            await removeStored(session.store, session.id);
            this.goIdle();

            return null;
        }

        const blob = new Blob(session.slices, { type: session.mimeType });

        if (blob.size < this.settings.minRecordingBytes) {
            this.emitEmptyProblem(session);
            await removeStored(session.store, session.id);
            this.goIdle();

            return null;
        }

        const finalBlob = await this.finalizeBlob(blob, session.mimeType);
        const finished = buildFinished(session, finalBlob);

        this.goIdle();
        this.emit('finish', finished);

        return finished;
    }

    private emitEmptyProblem(session: RecordingSession): void {
        if (!session.hasProblem) {
            this.emitProblem(session, 'EMPTY');
        }
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
