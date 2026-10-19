import { useEffect, useState } from 'react';
import { DurableRecorder } from '../recorder';
import type {
    DurableRecorderEvents,
    DurableRecorderOptions,
    FinishedRecording,
    RecorderProgress,
    RecorderState,
} from '../recorder';

interface RecorderActions {
    start: DurableRecorder['start'];
    stop: DurableRecorder['stop'];
    cancel: DurableRecorder['cancel'];
    pause: DurableRecorder['pause'];
    resume: DurableRecorder['resume'];
    listRecoverable: DurableRecorder['listRecoverable'];
    continueRecording: DurableRecorder['continueRecording'];
}

interface UseDurableRecorderResult extends RecorderActions {
    recorder: DurableRecorder;
    state: RecorderState;
    progress: RecorderProgress;
    problems: DurableRecorderEvents['problem'][];
    finished: FinishedRecording | null;
}

const EMPTY_PROGRESS: RecorderProgress = { durationMs: 0, sizeBytes: 0 };

/**
 * Owns one DurableRecorder for the component. The options are read on the first
 * render only. Later changes to the options are ignored. Unmounting removes the
 * listeners and stops a recording that is still running. The stored copy is kept,
 * so listRecoverable finds it later, and the microphone is released.
 */
function useDurableRecorder(options: DurableRecorderOptions = {}): UseDurableRecorderResult {
    const [recorder] = useState(() => new DurableRecorder(options));
    const [actions] = useState<RecorderActions>(() => ({
        start: () => recorder.start(),
        stop: () => recorder.stop(),
        cancel: () => recorder.cancel(),
        pause: (): void => {
            recorder.pause();
        },
        resume: (): void => {
            recorder.resume();
        },
        listRecoverable: () => recorder.listRecoverable(),
        continueRecording: (recordingId: string) => recorder.continueRecording(recordingId),
    }));
    const [state, setState] = useState<RecorderState>('idle');
    const [progress, setProgress] = useState<RecorderProgress>(EMPTY_PROGRESS);
    const [problems, setProblems] = useState<DurableRecorderEvents['problem'][]>([]);
    const [finished, setFinished] = useState<FinishedRecording | null>(null);

    // StrictMode runs this effect twice on mount. The stop does nothing then,
    // because no recording has started, and the listeners are attached again.
    useEffect(() => {
        const removers = [
            recorder.on('state', (payload) => {
                if (payload.state === 'starting') {
                    setProgress(EMPTY_PROGRESS);
                    setProblems([]);
                    setFinished(null);
                }

                setState(payload.state);
            }),
            recorder.on('progress', (payload) => {
                setProgress(payload);
            }),
            recorder.on('problem', (payload) => {
                setProblems(previous => [...previous, payload]);
            }),
            recorder.on('finish', (result) => {
                setFinished(result);
            }),
        ];

        return () => {
            removers.forEach((remove) => {
                remove();
            });
            void recorder.stop()
                .catch(() => undefined);
        };
    }, [recorder]);

    return {
        ...actions,
        recorder,
        state,
        progress,
        problems,
        finished,
    };
}

export { useDurableRecorder };
export type { UseDurableRecorderResult };
