type RecordingSourceKind = 'audio' | 'video' | 'screen' | 'stream';

interface RecordingMeta {
    id: string;
    mimeType: string;
    source: RecordingSourceKind;
    createdAt: number; // ms since epoch
    updatedAt: number; // ms since epoch
    metadata: Record<string, unknown>; // app data, must be structured-cloneable
    nextSegment: number; // index the next continued take will use
}

interface StoredChunk {
    recordingId: string;
    segment: number; // 0 for the first take
    position: number; // order of the slice inside its segment
    data: ArrayBuffer;
}

interface StoredRecording extends RecordingMeta {
    segments: Blob[]; // one Blob per segment, in segment order
}

interface RecordingStoreOptions {
    databaseName?: string; // default 'durable-recorder'
    retentionDays?: number; // default 30
    minSegmentBytes?: number; // default 1024. Smaller segments are dropped on load
    indexedDB?: IDBFactory; // default globalThis.indexedDB. Lets tests inject a fake
}

export type {
    RecordingMeta,
    RecordingSourceKind,
    RecordingStoreOptions,
    StoredChunk,
    StoredRecording,
};
