import type { RecorderError, RecorderProblemCode } from '../errors/RecorderError';
import type { MonitorFactory } from '../monitors/RecordingMonitor';
import type { RecordingSource } from '../sources/sourceTypes';
import type { RecordingStore } from '../storage/RecordingStore';

type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';
type LimitKind = 'bytes' | 'duration';
type LimitAction = 'stop' | 'event';

interface DurableRecorderOptions {
    source?: RecordingSource; // default 'audio'
    audio?: MediaTrackConstraints | boolean;
    video?: MediaTrackConstraints | boolean;
    mimeType?: string; // preferred, passed to pickMimeType
    timeslice?: number; // ms between slices, default 500
    audioBitsPerSecond?: number;
    videoBitsPerSecond?: number;
    maxBytes?: number; // no limit when undefined
    maxDurationMs?: number; // no limit when undefined
    onLimit?: LimitAction; // default 'stop'
    warnAt?: number; // fraction from 0 to 1, default 0.9
    metadata?: Record<string, unknown>; // default {}
    store?: RecordingStore | null; // default new RecordingStore(). null keeps the slices in memory only
    minRecordingBytes?: number; // default 1024
    /**
     * Days a recording may stay unchanged before it is pruned. Default 30.
     * Infinity means never expire. Ignored when store is set, because that store has its own retention.
     */
    retentionDays?: number;
    /**
     * Same signature as mergeSegments from the container entry.
     * continueRecording and the stop of a continued recording need it.
     */
    mergeSegments?: (segments: Blob[], mimeType: string) => Promise<Blob | null>;
    monitors?: MonitorFactory[]; // default createDefaultMonitors(source)
    finalize?: (recording: Blob, mimeType: string) => Promise<Blob>; // optional, for example finalizeRecording from the container entry
}

interface RecorderProgress {
    durationMs: number;
    sizeBytes: number;
}

interface FinishedRecording {
    id: string;
    blob: Blob;
    mimeType: string;
    extension: string;
    durationMs: number;
    sizeBytes: number;
    metadata: Record<string, unknown>;
    segments: number; // how many segments the blob contains. 1 for a normal recording
}

interface DurableRecorderEvents {
    'state': { state: RecorderState };
    'progress': RecorderProgress;
    'problem': { code: RecorderProblemCode; error: RecorderError };
    'silence': { secondsLeft: number };
    'limit-near': { kind: LimitKind; ratio: number };
    'limit': { kind: LimitKind };
    'storage-error': { error: unknown };
    'finish': FinishedRecording;
}

export type {
    DurableRecorderEvents,
    DurableRecorderOptions,
    FinishedRecording,
    LimitAction,
    LimitKind,
    RecorderProgress,
    RecorderState,
};
