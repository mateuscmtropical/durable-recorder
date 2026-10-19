function getStorageManager(): StorageManager | undefined {
    if (typeof navigator === 'undefined') {
        return undefined;
    }

    return navigator.storage;
}

async function estimateAvailableBytes(): Promise<number | null> {
    const storage = getStorageManager();

    if (typeof storage?.estimate !== 'function') {
        return null;
    }

    try {
        const { quota, usage } = await storage.estimate();

        if (typeof quota !== 'number' || typeof usage !== 'number') {
            return null;
        }

        return quota - usage;
    } catch {
        return null;
    }
}

async function requestPersistentStorage(): Promise<boolean> {
    const storage = getStorageManager();

    if (typeof storage?.persist !== 'function') {
        return false;
    }

    try {
        return await storage.persist();
    } catch {
        return false;
    }
}

export { estimateAvailableBytes, requestPersistentStorage };
