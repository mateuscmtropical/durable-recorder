import type { MonitorContext, MonitorFactory, MonitorProblemCode, RecordingMonitor } from './RecordingMonitor';

interface InterruptionMonitorOptions {
    checkIntervalMs?: number; // default 250
    noDataLimitMs?: number; // default 5000
    muteGraceMs?: number; // default 2000
}

const DEFAULT_CHECK_INTERVAL_MS = 250;
const DEFAULT_NO_DATA_LIMIT_MS = 5000;
const DEFAULT_MUTE_GRACE_MS = 2000;

function createInterruptionMonitor(options?: InterruptionMonitorOptions): MonitorFactory {
    const checkIntervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    const noDataLimitMs = options?.noDataLimitMs ?? DEFAULT_NO_DATA_LIMIT_MS;
    const muteGraceMs = options?.muteGraceMs ?? DEFAULT_MUTE_GRACE_MS;

    return (context: MonitorContext): RecordingMonitor => {
        const { stream, reportProblem } = context;
        const tracks = stream.getTracks();
        const reportedCodes = new Set<MonitorProblemCode>();
        const hasMutedTrack = (): boolean => tracks.some(track => track.muted);

        const report = (problemCode: MonitorProblemCode): void => {
            if (isReleased || reportedCodes.has(problemCode)) {
                return;
            }

            reportedCodes.add(problemCode);
            reportProblem(problemCode);
        };

        const clearMuteTimer = (): void => {
            if (muteTimer !== null) {
                clearTimeout(muteTimer);
            }

            muteTimer = null;
        };

        // A mute that is not followed by an unmute within the grace period
        // means the input is gone. Muted tracks are not a problem while paused.
        const startMuteTimer = (): void => {
            clearMuteTimer();

            if (isPaused || isReleased) {
                return;
            }

            muteTimer = setTimeout(() => {
                report('INTERRUPTED');
            }, muteGraceMs);
        };

        const checkNoData = (): void => {
            if (isPaused) {
                return;
            }

            const elapsedMs = Date.now() - lastDataAt;

            if (elapsedMs > noDataLimitMs) {
                report('NO_DATA');
            }
        };

        const handleEnded = (): void => {
            report('INTERRUPTED');
        };

        const handleUnmute = (): void => {
            // Another track can still be muted. Keep the timer for that one.
            if (!hasMutedTrack()) {
                clearMuteTimer();
            }
        };

        const checkTimer = setInterval(checkNoData, checkIntervalMs);

        let lastDataAt = Date.now();
        let isPaused = false;
        let isReleased = false;
        let muteTimer: ReturnType<typeof setTimeout> | null = null;

        tracks.forEach((track) => {
            track.addEventListener('ended', handleEnded);
            track.addEventListener('mute', startMuteTimer);
            track.addEventListener('unmute', handleUnmute);
        });

        return {
            noteData: () => {
                lastDataAt = Date.now();
            },
            pause: () => {
                isPaused = true;
                clearMuteTimer();
            },
            resume: () => {
                isPaused = false;
                lastDataAt = Date.now();

                if (hasMutedTrack()) {
                    startMuteTimer();
                }
            },
            release: () => {
                if (isReleased) {
                    return;
                }

                isReleased = true;
                clearInterval(checkTimer);
                clearMuteTimer();
                tracks.forEach((track) => {
                    track.removeEventListener('ended', handleEnded);
                    track.removeEventListener('mute', startMuteTimer);
                    track.removeEventListener('unmute', handleUnmute);
                });
            },
        };
    };
}

export { createInterruptionMonitor };
export type { InterruptionMonitorOptions };
