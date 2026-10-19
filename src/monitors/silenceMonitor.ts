import { createAudioContext } from './createAudioContext';
import type { MonitorContext, MonitorFactory, RecordingMonitor } from './RecordingMonitor';

interface SilenceMonitorOptions {
    checkIntervalMs?: number; // default 250
    limitMs?: number; // default 20000. Silence this long reports SILENCE
    warningMs?: number; // default 5000. After this much silence, warnSilence(secondsLeft) every second
    rmsThreshold?: number; // default 0.0001
    createAudioContext?: () => AudioContext | null; // default createAudioContext from createAudioContext.ts
}

interface Meter {
    audioContext: AudioContext;
    analyser: AnalyserNode;
}

const DEFAULT_CHECK_INTERVAL_MS = 250;
const DEFAULT_LIMIT_MS = 20000;
const DEFAULT_WARNING_MS = 5000;
const DEFAULT_RMS_THRESHOLD = 0.0001;

// Hidden tabs run timers about once per second, so a gap this long is still
// normal throttling and not a freeze.
const MIN_THROTTLE_GAP_MS = 2000;

// Used when measuring is impossible. A monitor must never report SILENCE
// because the measurement failed.
const NOOP_MONITOR: RecordingMonitor = {
    noteData: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    release: () => undefined,
};

// close() and resume() can reject or throw when the browser refuses them.
// Nothing is left to do then.
function runIgnoringFailures(action: () => Promise<void>): void {
    try {
        action()
            .catch(() => undefined);
    } catch {
        // The action threw before it returned a promise. Nothing is left to do.
    }
}

function connectAnalyser(audioContext: AudioContext, stream: MediaStream): AnalyserNode | null {
    try {
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();

        source.connect(analyser);

        return analyser;
    } catch {
        return null;
    }
}

function startMeter(stream: MediaStream, createContext: () => AudioContext | null): Meter | null {
    if (stream.getAudioTracks().length === 0) {
        return null;
    }

    const audioContext = createContext();

    if (!audioContext) {
        return null;
    }

    const analyser = connectAnalyser(audioContext, stream);

    if (!analyser) {
        runIgnoringFailures(() => audioContext.close());

        return null;
    }

    return { audioContext, analyser };
}

function calculateRms(samples: Float32Array): number {
    const sumOfSquares = samples.reduce((sum, sample) => sum + sample * sample, 0);

    return Math.sqrt(sumOfSquares / samples.length);
}

function createSilenceMonitor(options?: SilenceMonitorOptions): MonitorFactory {
    const checkIntervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    const limitMs = options?.limitMs ?? DEFAULT_LIMIT_MS;
    const warningMs = options?.warningMs ?? DEFAULT_WARNING_MS;
    const rmsThreshold = options?.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    const createContext = options?.createAudioContext ?? createAudioContext;
    const throttleGapMs = Math.max(2 * checkIntervalMs, MIN_THROTTLE_GAP_MS);

    return (context: MonitorContext): RecordingMonitor => {
        const { stream, reportProblem, warnSilence } = context;
        const meter = startMeter(stream, createContext);

        if (!meter) {
            return NOOP_MONITOR;
        }

        const { audioContext, analyser } = meter;
        const samples = new Float32Array(analyser.fftSize);

        const isSilentNow = (): boolean => {
            // A suspended context gives no samples. Treat it as sound.
            if (audioContext.state !== 'running') {
                return false;
            }

            analyser.getFloatTimeDomainData(samples);

            return calculateRms(samples) < rmsThreshold;
        };

        const updateWarning = (secondsLeft: number): void => {
            if (warningSeconds === secondsLeft) {
                return;
            }

            warningSeconds = secondsLeft;
            warnSilence(secondsLeft);
        };

        const clearWarning = (): void => {
            if (warningSeconds === null) {
                return;
            }

            warningSeconds = null;
            warnSilence(0);
        };

        const reportSilence = (): void => {
            if (isSilenceReported) {
                return;
            }

            isSilenceReported = true;
            reportProblem('SILENCE');
        };

        const checkSilence = (): void => {
            const now = Date.now();
            const gapMs = now - lastCheckAt;

            lastCheckAt = now;

            // Once-per-second background timers still count as silence. Only a
            // longer freeze, such as a suspended page, restarts the clock.
            if (gapMs > throttleGapMs) {
                silenceStartedAt = null;
                clearWarning();
            }

            if (!isSilentNow()) {
                silenceStartedAt = null;
                clearWarning();

                return;
            }

            if (silenceStartedAt === null) {
                silenceStartedAt = now;
            }

            const silentForMs = now - silenceStartedAt;

            if (silentForMs >= limitMs) {
                reportSilence();

                return;
            }

            if (silentForMs >= warningMs) {
                const secondsLeft = Math.ceil((limitMs - silentForMs) / 1000);

                updateWarning(secondsLeft);
            }
        };

        const handleVisibilityChange = (): void => {
            if (document.visibilityState !== 'visible') {
                return;
            }

            runIgnoringFailures(() => audioContext.resume());
        };

        const startChecks = (): void => {
            if (isReleased || checkTimer !== null) {
                return;
            }

            checkTimer = setInterval(checkSilence, checkIntervalMs);
        };

        const stopChecks = (): void => {
            if (checkTimer !== null) {
                clearInterval(checkTimer);
            }

            checkTimer = null;
        };

        let lastCheckAt = Date.now();
        let silenceStartedAt: number | null = lastCheckAt;
        let warningSeconds: number | null = null;
        let isSilenceReported = false;
        let isReleased = false;
        let checkTimer: ReturnType<typeof setInterval> | null = null;

        document.addEventListener('visibilitychange', handleVisibilityChange);
        startChecks();

        return {
            noteData: () => undefined,
            pause: () => {
                if (isReleased) {
                    return;
                }

                stopChecks();
                clearWarning();
            },
            resume: () => {
                if (isReleased) {
                    return;
                }

                lastCheckAt = Date.now();
                silenceStartedAt = lastCheckAt;
                startChecks();
            },
            release: () => {
                if (isReleased) {
                    return;
                }

                isReleased = true;
                stopChecks();
                document.removeEventListener('visibilitychange', handleVisibilityChange);
                runIgnoringFailures(() => audioContext.close());
            },
        };
    };
}

export { createSilenceMonitor };
export type { SilenceMonitorOptions };
