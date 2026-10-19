import type { RecorderProblemCode } from '../errors/RecorderError';

type MonitorProblemCode = Extract<RecorderProblemCode, 'NO_DATA' | 'SILENCE' | 'INTERRUPTED'>;

interface MonitorContext {
    stream: MediaStream;
    // Report a problem that should stop the recording. Monitors may call it
    // many times. The recorder acts on the first call only.
    reportProblem: (code: MonitorProblemCode) => void;
    // Seconds left before a silence problem is reported. 0 clears the warning.
    warnSilence: (secondsLeft: number) => void;
}

interface RecordingMonitor {
    noteData: () => void; // a MediaRecorder slice with data arrived
    pause: () => void; // the recording was paused by the app
    resume: () => void; // the recording resumed
    release: () => void; // stop timers, remove listeners, free resources. Safe to call twice
}

type MonitorFactory = (context: MonitorContext) => RecordingMonitor;

export type { MonitorProblemCode, MonitorContext, RecordingMonitor, MonitorFactory };
