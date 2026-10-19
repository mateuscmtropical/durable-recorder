import type { MonitorFactory, RecordingMonitor } from './RecordingMonitor';

function readWakeLockApi(): WakeLock | undefined {
    // The DOM types say this is always present. It is missing in some browsers,
    // so it is typed as optional here.
    const wakeLockApi: WakeLock | undefined = navigator.wakeLock;

    return wakeLockApi;
}

function createWakeLockMonitor(): MonitorFactory {
    return (): RecordingMonitor => {
        const isHeld = (): boolean => wakeLock !== null && !wakeLock.released;

        const releaseLock = (lock: WakeLockSentinel): void => {
            // Release can fail when the lock is already gone. Nothing is left to do then.
            void lock.release()
                .catch(() => undefined);
        };

        const releaseCurrentLock = (): void => {
            const currentLock = wakeLock;

            wakeLock = null;

            if (currentLock !== null) {
                releaseLock(currentLock);
            }
        };

        const requestWakeLock = (): void => {
            const screenWakeLockApi = readWakeLockApi();

            if (screenWakeLockApi === undefined || document.visibilityState !== 'visible') {
                return;
            }

            if (isPaused || isReleased || isRequesting || isHeld()) {
                return;
            }

            isRequesting = true;
            void screenWakeLockApi.request('screen')
                .then((lock) => {
                    // A lock that arrives after pause or release must not stay held.
                    if (isPaused || isReleased) {
                        releaseLock(lock);

                        return;
                    }

                    wakeLock = lock;
                })
                // A refused request is not a recording problem. The next visible
                // change tries again, so the error is ignored.
                .catch(() => undefined)
                .finally(() => {
                    isRequesting = false;
                });
        };

        const handleVisibilityChange = (): void => {
            if (document.visibilityState === 'visible') {
                requestWakeLock();
            }
        };

        let wakeLock: WakeLockSentinel | null = null;
        let isRequesting = false;
        let isPaused = false;
        let isReleased = false;

        document.addEventListener('visibilitychange', handleVisibilityChange);
        requestWakeLock();

        return {
            // The screen lock does not depend on recorded data.
            noteData: () => undefined,
            pause: () => {
                isPaused = true;
                releaseCurrentLock();
            },
            resume: () => {
                isPaused = false;
                requestWakeLock();
            },
            release: () => {
                if (isReleased) {
                    return;
                }

                isReleased = true;
                releaseCurrentLock();
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            },
        };
    };
}

export { createWakeLockMonitor };
