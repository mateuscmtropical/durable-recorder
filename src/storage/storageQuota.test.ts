import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateAvailableBytes, requestPersistentStorage } from './storageQuota';

function stubStorage(storage: unknown): void {
    vi.stubGlobal('navigator', { storage });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('estimateAvailableBytes', () => {
    it('returns the quota minus the usage', async () => {
        stubStorage({ estimate: () => Promise.resolve({ quota: 1000, usage: 250 }) });

        await expect(estimateAvailableBytes()).resolves.toBe(750);
    });

    it('returns the whole quota when nothing is used yet', async () => {
        stubStorage({ estimate: () => Promise.resolve({ quota: 1000, usage: 0 }) });

        await expect(estimateAvailableBytes()).resolves.toBe(1000);
    });

    it('returns null when the storage API is missing', async () => {
        stubStorage(undefined);

        await expect(estimateAvailableBytes()).resolves.toBeNull();
    });

    it('returns null when the estimate method is missing', async () => {
        stubStorage({});

        await expect(estimateAvailableBytes()).resolves.toBeNull();
    });

    it('returns null when the estimate rejects', async () => {
        stubStorage({ estimate: () => Promise.reject(new Error('Denied')) });

        await expect(estimateAvailableBytes()).resolves.toBeNull();
    });

    it('returns null when the estimate throws', async () => {
        stubStorage({
            estimate: () => {
                throw new Error('Denied');
            },
        });

        await expect(estimateAvailableBytes()).resolves.toBeNull();
    });

    it.each([
        [{}],
        [{ quota: 1000 }],
        [{ usage: 250 }],
        [{ quota: '1000', usage: 250 }],
    ])('returns null when the estimate does not report both numbers: %j', async (estimate) => {
        stubStorage({ estimate: () => Promise.resolve(estimate) });

        await expect(estimateAvailableBytes()).resolves.toBeNull();
    });
});

describe('requestPersistentStorage', () => {
    it('returns true and asks the browser once when persistence is granted', async () => {
        const persist = vi.fn(() => Promise.resolve(true));

        stubStorage({ persist });

        await expect(requestPersistentStorage()).resolves.toBe(true);
        expect(persist)
            .toHaveBeenCalledTimes(1);
    });

    it('returns false when the browser refuses persistence', async () => {
        stubStorage({ persist: () => Promise.resolve(false) });

        await expect(requestPersistentStorage()).resolves.toBe(false);
    });

    it('returns false when the storage API is missing', async () => {
        stubStorage(undefined);

        await expect(requestPersistentStorage()).resolves.toBe(false);
    });

    it('returns false when the persist method is missing', async () => {
        stubStorage({});

        await expect(requestPersistentStorage()).resolves.toBe(false);
    });

    it('returns false when persist rejects', async () => {
        stubStorage({ persist: () => Promise.reject(new Error('Denied')) });

        await expect(requestPersistentStorage()).resolves.toBe(false);
    });

    it('returns false when persist throws', async () => {
        stubStorage({
            persist: () => {
                throw new Error('Denied');
            },
        });

        await expect(requestPersistentStorage()).resolves.toBe(false);
    });
});
