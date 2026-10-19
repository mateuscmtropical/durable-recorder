import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRecordingId } from './createRecordingId';

const RFC_4122_VERSION_4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Captured at import time, before any test replaces the global crypto object.
const nativeCrypto = globalThis.crypto;

function createByteFiller(byteValue: number): (array: ArrayBufferView) => ArrayBufferView {
    return (array) => {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

        bytes.fill(byteValue);

        return array;
    };
}

describe('createRecordingId', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns an RFC 4122 version 4 UUID', () => {
        const recordingId = createRecordingId();

        expect(recordingId)
            .toMatch(RFC_4122_VERSION_4_PATTERN);
    });

    it('returns a different id on each call', () => {
        const recordingIds = Array.from({ length: 100 }, () => createRecordingId());

        expect(new Set(recordingIds).size)
            .toBe(100);
    });

    it('returns the value of crypto.randomUUID when it exists', () => {
        const randomUuid = '6f1c2b7e-9a4d-4e3b-8c2a-1d2e3f4a5b6c';
        const getRandomValues = vi.fn(createByteFiller(0x00));

        vi.stubGlobal('crypto', {
            randomUUID: vi.fn(() => randomUuid),
            getRandomValues,
        });

        expect(createRecordingId())
            .toBe(randomUuid);
        expect(getRandomValues).not.toHaveBeenCalled();
    });

    it('builds the id from 16 random bytes when randomUUID is missing', () => {
        const requestedByteLengths: number[] = [];
        const fillBytes = createByteFiller(0x00);

        vi.stubGlobal('crypto', {
            getRandomValues: (array: ArrayBufferView): ArrayBufferView => {
                requestedByteLengths.push(array.byteLength);

                return fillBytes(array);
            },
        });

        expect(createRecordingId())
            .toBe('00000000-0000-4000-8000-000000000000');
        expect(requestedByteLengths)
            .toEqual([16]);
    });

    it('sets the version and variant bits on the fallback path', () => {
        vi.stubGlobal('crypto', {
            getRandomValues: createByteFiller(0xff),
        });

        expect(createRecordingId())
            .toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    });

    it('returns different ids on the fallback path with real random bytes', () => {
        vi.stubGlobal('crypto', {
            getRandomValues: (array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => nativeCrypto.getRandomValues(array),
        });

        const recordingIds = Array.from({ length: 50 }, () => createRecordingId());

        recordingIds.forEach((recordingId) => {
            expect(recordingId)
                .toMatch(RFC_4122_VERSION_4_PATTERN);
        });
        expect(new Set(recordingIds).size)
            .toBe(50);
    });
});
