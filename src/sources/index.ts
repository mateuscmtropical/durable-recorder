export type {
    AcquiredStream,
    RecordingSource,
    StreamRequest,
} from './sourceTypes';
export {
    AUDIO_MIME_TYPES,
    VIDEO_MIME_TYPES,
    baseMimeType,
    extensionForMimeType,
    pickMimeType,
} from './pickMimeType';
export {
    DEFAULT_AUDIO_CONSTRAINTS,
    DEFAULT_VIDEO_CONSTRAINTS,
    acquireStream,
    isRecordingSupported,
    releaseStream,
    streamHasVideo,
} from './acquireStream';
