import { requestPersistentStorage } from './storageQuota';
import type {
    RecordingMeta,
    RecordingStoreOptions,
    StoredChunk,
    StoredRecording,
} from './storageTypes';

const DEFAULT_DATABASE_NAME = 'durable-recorder';
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MIN_SEGMENT_BYTES = 1024;
const DATABASE_VERSION = 1;
const RECORDINGS_STORE = 'recordings';
const CHUNKS_STORE = 'chunks';
const RECORDING_INDEX = 'recordingId';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

class StorageUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('IndexedDB is unavailable for recordings.', { cause });

        this.name = 'StorageUnavailableError';
    }
}

function resolveFactory(factory?: IDBFactory): IDBFactory | undefined {
    if (factory) {
        return factory;
    }

    return typeof indexedDB === 'undefined' ? undefined : indexedDB;
}

function hasErrorName(error: unknown, name: string): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
}

// InvalidStateError comes from transaction() on a closed connection.
// AbortError comes from a transaction the closed connection cut short.
function isClosedConnectionError(error: unknown): boolean {
    return hasErrorName(error, 'InvalidStateError') || hasErrorName(error, 'AbortError');
}

// IDB methods return IDBRequest<any>, so the caller's type is applied here.
function requestResult<T>(request: IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => {
            resolve(request.result as T);
        };
        request.onerror = () => {
            const failure = request.error ?? new Error('IndexedDB request failed.');

            reject(failure);
        };
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const rejectWithError = (): void => {
            const failure = transaction.error ?? new Error('IndexedDB transaction failed.');

            reject(failure);
        };

        transaction.oncomplete = () => {
            resolve();
        };
        transaction.onerror = rejectWithError;
        transaction.onabort = rejectWithError;
    });
}

function createStores(database: IDBDatabase): void {
    database.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' });

    const chunks = database.createObjectStore(CHUNKS_STORE, { autoIncrement: true });

    chunks.createIndex(RECORDING_INDEX, 'recordingId');
}

function writeMeta(database: IDBDatabase, meta: RecordingMeta): Promise<void> {
    const transaction = database.transaction(RECORDINGS_STORE, 'readwrite');

    transaction.objectStore(RECORDINGS_STORE)
        .put(meta);

    return transactionDone(transaction);
}

// Chunks are stored as ArrayBuffer. Blob values are unreliable in IndexedDB
// on iOS Safari, see docs/ARCHITECTURE.md.
function writeChunk(database: IDBDatabase, chunk: StoredChunk): Promise<void> {
    const transaction = database.transaction(CHUNKS_STORE, 'readwrite');

    transaction.objectStore(CHUNKS_STORE)
        .add(chunk);

    return transactionDone(transaction);
}

function readAllMetas(database: IDBDatabase): Promise<RecordingMeta[]> {
    const transaction = database.transaction(RECORDINGS_STORE, 'readonly');
    const request = transaction.objectStore(RECORDINGS_STORE)
        .getAll();

    return requestResult<RecordingMeta[]>(request)
        .then(metas => metas.sort((first, second) => first.createdAt - second.createdAt));
}

// Chunks come back in index order, not write order, so sort them here.
function compareChunks(first: StoredChunk, second: StoredChunk): number {
    if (first.segment !== second.segment) {
        return first.segment - second.segment;
    }

    return first.position - second.position;
}

function createSegmentBlob(chunks: StoredChunk[], segment: number, mimeType: string): Blob {
    const segmentParts = chunks
        .filter(chunk => chunk.segment === segment)
        .map(chunk => chunk.data);

    return new Blob(segmentParts, { type: mimeType });
}

function groupSegments(chunks: StoredChunk[], mimeType: string, minSegmentBytes: number): Blob[] {
    const segmentNumbers = chunks.map(chunk => chunk.segment);
    const distinctSegments = [...new Set(segmentNumbers)];
    const segmentBlobs = distinctSegments.map(segment => createSegmentBlob(chunks, segment, mimeType));

    return segmentBlobs.filter(segmentBlob => segmentBlob.size >= minSegmentBytes);
}

async function readRecording(
    database: IDBDatabase, recordingId: string, minSegmentBytes: number,
): Promise<StoredRecording | null> {
    const transaction = database.transaction([RECORDINGS_STORE, CHUNKS_STORE], 'readonly');
    const metaRequest = transaction.objectStore(RECORDINGS_STORE)
        .get(recordingId);
    const chunkRequest = transaction.objectStore(CHUNKS_STORE)
        .index(RECORDING_INDEX)
        .getAll(recordingId);
    const metaPromise = requestResult<RecordingMeta | undefined>(metaRequest);
    const chunksPromise = requestResult<StoredChunk[]>(chunkRequest);
    const [meta, chunks] = await Promise.all([metaPromise, chunksPromise]);

    if (!meta) {
        return null;
    }

    chunks.sort(compareChunks);

    const segments = groupSegments(chunks, meta.mimeType, minSegmentBytes);

    return {
        ...meta,
        segments,
    };
}

function removeRecording(database: IDBDatabase, recordingId: string): Promise<void> {
    const transaction = database.transaction([RECORDINGS_STORE, CHUNKS_STORE], 'readwrite');
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const chunkIndex = chunks.index(RECORDING_INDEX);
    const chunkKeysRequest = chunkIndex.getAllKeys(recordingId);

    // getAllKeys on an index returns the primary keys of the chunks store.
    chunkKeysRequest.onsuccess = () => {
        chunkKeysRequest.result.forEach((chunkKey) => {
            chunks.delete(chunkKey);
        });
    };

    transaction.objectStore(RECORDINGS_STORE)
        .delete(recordingId);

    return transactionDone(transaction);
}

function removeSegmentsFrom(database: IDBDatabase, recordingId: string, fromSegment: number): Promise<void> {
    const transaction = database.transaction(CHUNKS_STORE, 'readwrite');
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const chunkIndex = chunks.index(RECORDING_INDEX);
    const cursorRequest = chunkIndex.openCursor(recordingId);

    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
            return;
        }

        const chunk = cursor.value as StoredChunk;

        if (chunk.segment >= fromSegment) {
            chunks.delete(cursor.primaryKey);
        }

        cursor.continue();
    };

    return transactionDone(transaction);
}

async function removeExpiredRecordings(database: IDBDatabase, cutoff: number): Promise<string[]> {
    const metas = await readAllMetas(database);
    const expiredIds = metas
        .filter(meta => meta.updatedAt < cutoff)
        .map(meta => meta.id);
    const removalsPromises = expiredIds.map(recordingId => removeRecording(database, recordingId));

    await Promise.all(removalsPromises);

    return expiredIds;
}

class RecordingStore {
    private readonly databaseName: string;
    private readonly factory: IDBFactory | undefined;
    private readonly retentionMs: number;
    private readonly minSegmentBytes: number;
    private connection: IDBDatabase | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private hasRequestedPersistence = false;

    constructor(options: RecordingStoreOptions = {}) {
        this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
        this.factory = options.indexedDB;
        this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * MILLISECONDS_PER_DAY;
        this.minSegmentBytes = options.minSegmentBytes ?? DEFAULT_MIN_SEGMENT_BYTES;
    }

    static isSupported(factory?: IDBFactory): boolean {
        return resolveFactory(factory) !== undefined;
    }

    saveMeta(meta: RecordingMeta): Promise<void> {
        if (!this.hasRequestedPersistence) {
            this.hasRequestedPersistence = true;
            void requestPersistentStorage();
        }

        return this.withDatabase(database => writeMeta(database, meta));
    }

    appendChunk(chunk: StoredChunk): Promise<void> {
        return this.withDatabase(database => writeChunk(database, chunk));
    }

    list(): Promise<RecordingMeta[]> {
        return this.withDatabase(database => readAllMetas(database));
    }

    load(recordingId: string): Promise<StoredRecording | null> {
        return this.withDatabase(database => readRecording(database, recordingId, this.minSegmentBytes));
    }

    delete(recordingId: string): Promise<void> {
        return this.withDatabase(database => removeRecording(database, recordingId));
    }

    dropSegments(recordingId: string, fromSegment: number): Promise<void> {
        return this.withDatabase(database => removeSegmentsFrom(database, recordingId, fromSegment));
    }

    pruneExpired(now = Date.now()): Promise<string[]> {
        const cutoff = now - this.retentionMs;

        return this.withDatabase(database => removeExpiredRecordings(database, cutoff));
    }

    close(): void {
        if (this.connection) {
            this.forgetConnection(this.connection);
        }
    }

    // One chain per store. A failed task rejects its own promise only.
    private withDatabase<T>(task: (database: IDBDatabase) => Promise<T>): Promise<T> {
        const result = this.queue.then(() => this.runTask(task));

        this.queue = result.catch(() => undefined);

        return result;
    }

    private async runTask<T>(task: (database: IDBDatabase) => Promise<T>): Promise<T> {
        const database = await this.connect();

        try {
            return await task(database);
        } catch (error) {
            // Other errors, such as a full quota, pass through unchanged.
            if (!isClosedConnectionError(error)) {
                throw error;
            }

            // iOS closes IndexedDB when the app goes to the background. Reopen once and retry.
            this.forgetConnection(database);

            const reopened = await this.connect();

            return task(reopened);
        }
    }

    private async connect(): Promise<IDBDatabase> {
        if (this.connection) {
            return this.connection;
        }

        const database = await this.openConnection();

        this.connection = database;

        return database;
    }

    private openConnection(): Promise<IDBDatabase> {
        return new Promise<IDBDatabase>((resolve, reject) => {
            const factory = resolveFactory(this.factory);

            if (!factory) {
                reject(new StorageUnavailableError());

                return;
            }

            let request: IDBOpenDBRequest;
            let isAbandoned = false;

            try {
                request = factory.open(this.databaseName, DATABASE_VERSION);
            } catch (error) {
                reject(new StorageUnavailableError(error));

                return;
            }

            request.onupgradeneeded = () => {
                createStores(request.result);
            };
            request.onsuccess = () => {
                const database = request.result;

                // Another tab can hold the database open and block the open.
                // The caller already got an error, so close the database if it opens later.
                if (isAbandoned) {
                    database.close();

                    return;
                }

                database.onclose = () => {
                    this.forgetConnection(database);
                };
                database.onversionchange = () => {
                    this.forgetConnection(database);
                };
                resolve(database);
            };
            request.onerror = () => {
                reject(new StorageUnavailableError(request.error));
            };
            request.onblocked = () => {
                isAbandoned = true;
                reject(new StorageUnavailableError());
            };
        });
    }

    private forgetConnection(database: IDBDatabase): void {
        if (this.connection === database) {
            this.connection = null;
        }

        database.close();
    }
}

export { RecordingStore };
