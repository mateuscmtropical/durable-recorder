import { IDBDatabase as FakeDatabase, IDBFactory, IDBObjectStore, IDBVersionChangeEvent, forceCloseDatabase } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore } from './RecordingStore';
import type { RecordingMeta, RecordingStoreOptions, StoredChunk } from './storageTypes';

const DEFAULT_DATABASE_NAME = 'durable-recorder';
const KIB = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19);

let factory: IDBFactory;

function recordingMeta(id: string, overrides: Partial<RecordingMeta> = {}): RecordingMeta {
    return {
        id,
        mimeType: 'audio/webm',
        source: 'audio',
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
        nextSegment: 1,
        ...overrides,
    };
}

function createChunk(recordingId: string, segment: number, position: number, fill: number, size: number): StoredChunk {
    const data = new ArrayBuffer(size);
    const view = new Uint8Array(data);

    view.fill(fill);

    return { recordingId, segment, position, data };
}

function createStore(options: Omit<RecordingStoreOptions, 'indexedDB'> = {}): RecordingStore {
    return new RecordingStore({ ...options, indexedDB: factory });
}

async function readBytes(blob: Blob): Promise<number[]> {
    const buffer = await blob.arrayBuffer();

    return Array.from(new Uint8Array(buffer));
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => {
            resolve(request.result);
        };
        request.onerror = () => {
            reject(new Error('IndexedDB request failed'));
        };
    });
}

function openRawDatabase(databaseName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory.open(databaseName);

        request.onsuccess = () => {
            resolve(request.result);
        };
        request.onerror = () => {
            reject(new Error(`Could not open ${databaseName}`));
        };
    });
}

// Reads every row of a store without going through RecordingStore.
async function readRows<T = unknown>(storeName: string, databaseName = DEFAULT_DATABASE_NAME): Promise<T[]> {
    const database = await openRawDatabase(databaseName);
    const transaction = database.transaction(storeName, 'readonly');
    const objectStore = transaction.objectStore(storeName);
    const rows = await requestToPromise<unknown[]>(objectStore.getAll());

    database.close();

    return rows as T[];
}

function createDatabaseAtVersion(databaseName: string, version: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = factory.open(databaseName, version);

        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => {
            reject(new Error('Could not create the database'));
        };
    });
}

// Records every connection the store opens. With closeOnOpen, each new
// connection is closed by the browser right after it opens, as iOS does
// when the app goes to the background.
function recordConnections(closeOnOpen = false): IDBDatabase[] {
    const connections: IDBDatabase[] = [];
    const realOpen = factory.open.bind(factory);

    vi.spyOn(factory, 'open')
        .mockImplementation((databaseName, version) => {
            const request = realOpen(databaseName, version);

            request.addEventListener('success', () => {
                connections.push(request.result);
                if (closeOnOpen) {
                    forceClose(request.result);
                }
            });

            return request;
        });

    return connections;
}

// fake-indexeddb types forceCloseDatabase with the constructor type, but it takes an instance.
function forceClose(database: IDBDatabase): void {
    forceCloseDatabase(database as unknown as typeof IDBDatabase);
}

async function expectStorageUnavailable(operation: Promise<unknown>): Promise<void> {
    await expect(operation).rejects.toBeInstanceOf(Error);
    await expect(operation).rejects.toMatchObject({ name: 'StorageUnavailableError' });
}

beforeEach(() => {
    factory = new IDBFactory();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('RecordingStore', () => {
    describe('saving and listing', () => {
        it('lists the recordings oldest first by createdAt', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('newer', { createdAt: 30 }));
            await store.saveMeta(recordingMeta('oldest', { createdAt: 10 }));
            await store.saveMeta(recordingMeta('middle', { createdAt: 20 }));

            const recordings = await store.list();

            expect(recordings.map(recording => recording.id))
                .toEqual(['oldest', 'middle', 'newer']);
        });

        it('lists only the metas, without segments or chunks', async () => {
            const store = createStore();
            const meta = recordingMeta('recording-1', { metadata: { interviewId: 7 } });

            await store.saveMeta(meta);
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB));

            const recordings = await store.list();

            expect(recordings)
                .toEqual([meta]);
        });

        it('replaces the meta when it is saved again with the same id', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1', { mimeType: 'audio/webm', updatedAt: 1 }));
            await store.saveMeta(recordingMeta('recording-1', { mimeType: 'video/webm', updatedAt: 2 }));

            const recordings = await store.list();

            expect(recordings)
                .toEqual([recordingMeta('recording-1', { mimeType: 'video/webm', updatedAt: 2 })]);
        });

        it('stores each chunk as an ArrayBuffer, not a Blob', async () => {
            await createStore()
                .appendChunk(createChunk('recording-1', 0, 0, 7, 4));

            const rows = await readRows<StoredChunk>('chunks');

            expect(rows)
                .toHaveLength(1);
            expect(rows[0])
                .toMatchObject({ recordingId: 'recording-1', segment: 0, position: 0 });
            expect(rows[0]!.data)
                .toBeInstanceOf(ArrayBuffer);
            expect(new Uint8Array(rows[0]!.data))
                .toEqual(new Uint8Array(4)
                    .fill(7));
        });
    });

    describe('database layout', () => {
        it('uses durable-recorder as the database name by default', async () => {
            await createStore()
                .list();

            const databases = await factory.databases();

            expect(databases.map(database => database.name))
                .toEqual([DEFAULT_DATABASE_NAME]);
        });

        it('uses the database name from the options, at version 1, with the recordings and chunks stores', async () => {
            await createStore({ databaseName: 'custom-recordings' })
                .list();

            const databases = await factory.databases();
            const database = await openRawDatabase('custom-recordings');
            const transaction = database.transaction(['recordings', 'chunks'], 'readonly');
            const recordingsStore = transaction.objectStore('recordings');
            const chunksStore = transaction.objectStore('chunks');

            database.close();

            expect(databases)
                .toContainEqual(expect.objectContaining({ name: 'custom-recordings', version: 1 }));
            expect(recordingsStore.keyPath)
                .toBe('id');
            expect(chunksStore.autoIncrement)
                .toBe(true);
            expect(chunksStore.indexNames.contains('recordingId'))
                .toBe(true);
        });
    });

    describe('loading', () => {
        it('groups the chunks into one Blob per segment, in segment order', async () => {
            const store = createStore({ minSegmentBytes: 1 });

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 1, 0, 3, 1));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, 3));
            await store.appendChunk(createChunk('recording-1', 0, 1, 2, 2));

            const recording = await store.load('recording-1');

            expect(recording!.segments)
                .toHaveLength(2);
            expect(await readBytes(recording!.segments[0]!))
                .toEqual([1, 1, 1, 2, 2]);
            expect(await readBytes(recording!.segments[1]!))
                .toEqual([3]);
        });

        it('loads the chunks of a segment in position order even when they were appended out of order', async () => {
            const store = createStore({ minSegmentBytes: 1 });

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 0, 2, 3, 1));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, 1));
            await store.appendChunk(createChunk('recording-1', 0, 1, 2, 1));

            const recording = await store.load('recording-1');

            expect(recording!.segments)
                .toHaveLength(1);
            expect(await readBytes(recording!.segments[0]!))
                .toEqual([1, 2, 3]);
        });

        it('returns the meta with Blob segments typed with the recording mimeType', async () => {
            const store = createStore();
            const meta = recordingMeta('recording-1', { mimeType: 'video/mp4' });

            await store.saveMeta(meta);
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB));

            const recording = await store.load('recording-1');

            expect(recording)
                .toMatchObject(meta);
            expect(recording!.segments[0])
                .toBeInstanceOf(Blob);
            expect(recording!.segments[0]!.type)
                .toBe('video/mp4');
        });

        it('stores chunks as ArrayBuffer and returns Blob segments that are not Files', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB));

            const rows = await readRows<StoredChunk>('chunks');
            const recording = await store.load('recording-1');

            expect(rows[0]!.data)
                .toBeInstanceOf(ArrayBuffer);
            expect(recording!.segments[0])
                .toBeInstanceOf(Blob);
            expect(recording!.segments[0])
                .not.toBeInstanceOf(File);
        });

        it('returns null when the recording does not exist', async () => {
            await expect(createStore()
                .load('missing')).resolves.toBeNull();
        });

        it('returns a recording with no segments when it has no chunks or only chunks too small to keep', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('empty'));
            await store.saveMeta(recordingMeta('tiny'));
            await store.appendChunk(createChunk('tiny', 0, 0, 1, 10));

            await expect(store.load('empty')).resolves.toEqual({ ...recordingMeta('empty'), segments: [] });
            await expect(store.load('tiny')).resolves.toEqual({ ...recordingMeta('tiny'), segments: [] });
        });
    });

    describe('minSegmentBytes', () => {
        it('drops segments smaller than minSegmentBytes when loading', async () => {
            const store = createStore({ minSegmentBytes: 100 });

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, 99));
            await store.appendChunk(createChunk('recording-1', 1, 0, 2, 150));

            const recording = await store.load('recording-1');

            expect(recording!.segments)
                .toHaveLength(1);
            expect(await readBytes(recording!.segments[0]!))
                .toHaveLength(150);
        });

        it('defaults to 1024 bytes and keeps a segment of exactly that size', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB - 1));
            await store.appendChunk(createChunk('recording-1', 1, 0, 2, KIB));

            const recording = await store.load('recording-1');

            expect(recording!.segments)
                .toHaveLength(1);
            expect(await readBytes(recording!.segments[0]!))
                .toEqual(new Array<number>(KIB)
                    .fill(2));
        });
    });

    describe('delete', () => {
        it('removes the meta and every chunk of the recording, and nothing else', async () => {
            const store = createStore();
            const kept = recordingMeta('recording-2');

            await store.saveMeta(recordingMeta('recording-1'));
            await store.saveMeta(kept);
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB));
            await store.appendChunk(createChunk('recording-1', 1, 0, 2, KIB));
            await store.appendChunk(createChunk('recording-2', 0, 0, 3, KIB));

            await store.delete('recording-1');

            expect(await store.list())
                .toEqual([kept]);
            expect(await store.load('recording-1'))
                .toBeNull();
            expect(await readRows('recordings'))
                .toHaveLength(1);
            expect(await readRows('chunks'))
                .toHaveLength(1);
        });

        it('does not fail when the recording does not exist', async () => {
            await expect(createStore()
                .delete('missing')).resolves.toBeUndefined();
        });
    });

    describe('dropSegments', () => {
        it('removes the chunks from the given segment on and keeps the earlier ones', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB));
            await store.appendChunk(createChunk('recording-1', 1, 0, 2, KIB));
            await store.appendChunk(createChunk('recording-1', 2, 0, 3, KIB));

            await store.dropSegments('recording-1', 1);

            const recording = await store.load('recording-1');

            expect(recording!.segments)
                .toHaveLength(1);
            expect((await readBytes(recording!.segments[0]!))[0])
                .toBe(1);
            expect(await readRows('chunks'))
                .toHaveLength(1);
        });

        it('keeps the recording itself', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            await store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB));
            await store.dropSegments('recording-1', 0);

            const recording = await store.load('recording-1');

            expect(recording)
                .toMatchObject({ id: 'recording-1', segments: [] });
        });
    });

    describe('pruneExpired', () => {
        it('deletes the recordings not updated within the default 30 days and returns their ids', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('expired-1', { updatedAt: NOW - 31 * DAY_MS }));
            await store.saveMeta(recordingMeta('expired-2', { updatedAt: NOW - 45 * DAY_MS }));
            await store.saveMeta(recordingMeta('fresh', { updatedAt: NOW - 29 * DAY_MS }));

            const pruned = await store.pruneExpired(NOW);

            expect([...pruned].sort())
                .toEqual(['expired-1', 'expired-2']);
            expect((await store.list()).map(recording => recording.id))
                .toEqual(['fresh']);
        });

        it('judges age by updatedAt, so a recording updated recently is kept even if created long ago', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('old-but-active', { createdAt: NOW - 60 * DAY_MS, updatedAt: NOW - DAY_MS }));

            const pruned = await store.pruneExpired(NOW);

            expect(pruned)
                .toEqual([]);
            expect(await store.load('old-but-active')).not.toBeNull();
        });

        it('uses retentionDays from the options', async () => {
            const store = createStore({ retentionDays: 1 });

            await store.saveMeta(recordingMeta('two-days-old', { updatedAt: NOW - 2 * DAY_MS }));
            await store.saveMeta(recordingMeta('half-day-old', { updatedAt: NOW - DAY_MS / 2 }));

            const pruned = await store.pruneExpired(NOW);

            expect(pruned)
                .toEqual(['two-days-old']);
        });

        it('removes the chunks of the recordings it prunes', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('expired', { updatedAt: NOW - 31 * DAY_MS }));
            await store.appendChunk(createChunk('expired', 0, 0, 1, KIB));

            await store.pruneExpired(NOW);

            expect(await readRows('recordings'))
                .toEqual([]);
            expect(await readRows('chunks'))
                .toEqual([]);
        });

        it('uses the current time when no time is given', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('expired', { updatedAt: Date.now() - 31 * DAY_MS }));

            const pruned = await store.pruneExpired();

            expect(pruned)
                .toEqual(['expired']);
        });
    });

    describe('serial queue', () => {
        it('runs the calls in the order they were made', async () => {
            const store = createStore();

            void store.saveMeta(recordingMeta('recording-1'));
            void store.delete('recording-1');
            void store.saveMeta(recordingMeta('recording-1', { mimeType: 'video/webm' }));

            const recordings = await store.list();

            expect(recordings)
                .toEqual([recordingMeta('recording-1', { mimeType: 'video/webm' })]);
        });

        it('keeps running the calls queued after a call that fails', async () => {
            const store = createStore();
            const failedSave = store.saveMeta(recordingMeta('broken', { metadata: { onSave: () => undefined } }));
            const laterSave = store.saveMeta(recordingMeta('recording-1'));

            await expect(failedSave).rejects.toThrow();
            await laterSave;

            const recordings = await store.list();

            expect(recordings.map(recording => recording.id))
                .toEqual(['recording-1']);
        });
    });

    describe('lazy open', () => {
        it('opens the database on first use and reuses the connection', async () => {
            const connections = recordConnections();
            const store = createStore();

            expect(connections)
                .toHaveLength(0);

            await store.saveMeta(recordingMeta('recording-1'));
            await store.list();
            await store.load('recording-1');

            expect(connections)
                .toHaveLength(1);
        });

        it('shares one connection between calls made before the first one finishes', async () => {
            const connections = recordConnections();
            const store = createStore();

            void store.saveMeta(recordingMeta('recording-1'));
            void store.saveMeta(recordingMeta('recording-2'));
            await store.list();

            expect(connections)
                .toHaveLength(1);
        });
    });

    describe('reconnecting', () => {
        it('reopens the database and retries the call once when the connection was closed', async () => {
            const connections = recordConnections();
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            connections[0]!.close();

            const recordings = await store.list();

            expect(recordings.map(recording => recording.id))
                .toEqual(['recording-1']);
            expect(connections)
                .toHaveLength(2);
        });

        it('forgets the connection when the browser fires the close event', async () => {
            const connections = recordConnections();
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));

            const closedConnection = connections[0]!;

            forceClose(closedConnection);

            const transactionSpy = vi.spyOn(FakeDatabase.prototype, 'transaction');
            const recordings = await store.list();

            expect(recordings.map(recording => recording.id))
                .toEqual(['recording-1']);
            expect(connections)
                .toHaveLength(2);
            expect(transactionSpy.mock.contexts)
                .not.toContain(closedConnection);
        });

        it('forgets the connection when a versionchange event arrives', async () => {
            const connections = recordConnections();
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            connections[0]!.dispatchEvent(new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2 }));

            const recordings = await store.list();

            expect(recordings.map(recording => recording.id))
                .toEqual(['recording-1']);
            expect(connections)
                .toHaveLength(2);
        });

        it('gives up after one retry when the connection is closed again', async () => {
            const connections = recordConnections(true);
            const store = createStore();

            await expect(store.list()).rejects.toThrow();
            expect(connections)
                .toHaveLength(2);
        });

        it('does not reopen the database for a failure that is not a closed connection', async () => {
            const connections = recordConnections();
            const store = createStore();

            await expect(store.saveMeta(recordingMeta('broken', { metadata: { onSave: () => undefined } })))
                .rejects.toThrow();

            expect(connections)
                .toHaveLength(1);
        });
    });

    describe('unavailable storage', () => {
        it('rejects every call with StorageUnavailableError when IndexedDB is missing', async () => {
            vi.stubGlobal('indexedDB', undefined);

            const store = new RecordingStore();

            await expectStorageUnavailable(store.list());
            await expectStorageUnavailable(store.saveMeta(recordingMeta('recording-1')));
            await expectStorageUnavailable(store.load('recording-1'));
        });

        it('rejects with StorageUnavailableError when the database cannot be opened', async () => {
            await createDatabaseAtVersion(DEFAULT_DATABASE_NAME, 2);

            const store = createStore();

            await expectStorageUnavailable(store.list());
        });

        it('rejects with StorageUnavailableError when opening throws at once', async () => {
            const brokenFactory = {
                open: () => {
                    throw new Error('Access denied');
                },
            } as unknown as IDBFactory;
            const store = new RecordingStore({ indexedDB: brokenFactory });

            await expectStorageUnavailable(store.list());
        });

        it('rejects with StorageUnavailableError when the open is blocked', async () => {
            const realOpen = factory.open.bind(factory);

            vi.spyOn(factory, 'open')
                .mockImplementation((databaseName, version) => {
                    const request = realOpen(databaseName, version);

                    queueMicrotask(() => {
                        request.dispatchEvent(new IDBVersionChangeEvent('blocked'));
                    });

                    return request;
                });

            const store = createStore();

            await expectStorageUnavailable(store.list());
        });
    });

    describe('write errors', () => {
        it('passes a QuotaExceededError from a write through unchanged', async () => {
            const quotaError = new DOMException('Storage is full', 'QuotaExceededError');

            vi.spyOn(IDBObjectStore.prototype, 'put')
                .mockImplementation(() => {
                    throw quotaError;
                });
            vi.spyOn(IDBObjectStore.prototype, 'add')
                .mockImplementation(() => {
                    throw quotaError;
                });

            const store = createStore();

            await expect(store.saveMeta(recordingMeta('recording-1'))).rejects.toBe(quotaError);
            await expect(store.appendChunk(createChunk('recording-1', 0, 0, 1, KIB))).rejects.toBe(quotaError);
        });
    });

    describe('persistent storage', () => {
        it('asks for persistent storage once per store on the first save and does not wait for the answer', async () => {
            const persist = vi.fn(() => new Promise<boolean>(() => undefined));

            vi.stubGlobal('navigator', { storage: { persist } });

            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            await store.saveMeta(recordingMeta('recording-2'));

            expect(persist)
                .toHaveBeenCalledTimes(1);

            await createStore()
                .saveMeta(recordingMeta('recording-3'));

            expect(persist)
                .toHaveBeenCalledTimes(2);
        });

        it('still saves when the persistent storage request fails', async () => {
            vi.stubGlobal('navigator', { storage: { persist: () => Promise.reject(new Error('Denied')) } });

            const store = createStore();

            await expect(store.saveMeta(recordingMeta('recording-1'))).resolves.toBeUndefined();
        });
    });

    describe('close', () => {
        it('closes the open connection', async () => {
            const connections = recordConnections();
            const store = createStore();

            await store.list();

            const closeSpy = vi.spyOn(connections[0]!, 'close');

            store.close();

            expect(closeSpy)
                .toHaveBeenCalledTimes(1);
        });

        it('keeps the stored recordings for the next store', async () => {
            const store = createStore();

            await store.saveMeta(recordingMeta('recording-1'));
            store.close();

            const recordings = await createStore()
                .list();

            expect(recordings.map(recording => recording.id))
                .toEqual(['recording-1']);
        });

        it('does not throw when the store was never used', () => {
            expect(() => {
                createStore()
                    .close();
            }).not.toThrow();
        });
    });

    describe('isSupported', () => {
        it('is true when an IndexedDB factory is given', () => {
            expect(RecordingStore.isSupported(factory))
                .toBe(true);
        });

        it('is true when the browser provides indexedDB', () => {
            vi.stubGlobal('indexedDB', factory);

            expect(RecordingStore.isSupported())
                .toBe(true);
        });

        it('is false when IndexedDB is missing', () => {
            vi.stubGlobal('indexedDB', undefined);

            expect(RecordingStore.isSupported())
                .toBe(false);
        });
    });
});
