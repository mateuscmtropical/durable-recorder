export type {
    RecordingMeta,
    RecordingSourceKind,
    RecordingStoreOptions,
    StoredChunk,
    StoredRecording,
} from './storageTypes';
export { RecordingStore } from './RecordingStore';
export { estimateAvailableBytes, requestPersistentStorage } from './storageQuota';
