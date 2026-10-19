export { TypedEventEmitter } from './shared/TypedEventEmitter';
export type { EventListener } from './shared/TypedEventEmitter';
export { createRecordingId } from './shared/createRecordingId';
export { RecorderError, RECORDER_PROBLEM_CODES, isRecorderError } from './errors/RecorderError';
export type { RecorderProblemCode } from './errors/RecorderError';
export { classifyStartError } from './errors/classifyStartError';
export { RecordingStore, estimateAvailableBytes, requestPersistentStorage } from './storage';
export type {
    RecordingMeta,
    RecordingSourceKind,
    RecordingStoreOptions,
    StoredChunk,
    StoredRecording,
} from './storage';
export { createInterruptionMonitor, createSilenceMonitor, createWakeLockMonitor } from './monitors';
export type {
    InterruptionMonitorOptions,
    MonitorContext,
    MonitorFactory,
    MonitorProblemCode,
    RecordingMonitor,
    SilenceMonitorOptions,
} from './monitors';
export {
    AUDIO_MIME_TYPES,
    VIDEO_MIME_TYPES,
    acquireStream,
    extensionForMimeType,
    isRecordingSupported,
    pickMimeType,
    releaseStream,
    streamHasVideo,
} from './sources';
export type { AcquiredStream, RecordingSource, StreamRequest } from './sources';
