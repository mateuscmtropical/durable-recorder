type RecorderProblemCode = 'DENIED' | 'NO_DEVICE' | 'DEVICE_BUSY' | 'UNSUPPORTED' | 'NO_DATA' | 'SILENCE' | 'INTERRUPTED' | 'EMPTY' | 'NOT_JOINED' | 'STORAGE_FULL';

const RECORDER_PROBLEM_CODES: readonly RecorderProblemCode[] = [
    'DENIED',
    'NO_DEVICE',
    'DEVICE_BUSY',
    'UNSUPPORTED',
    'NO_DATA',
    'SILENCE',
    'INTERRUPTED',
    'EMPTY',
    'NOT_JOINED',
    'STORAGE_FULL',
];

const DEFAULT_MESSAGES: Readonly<Record<RecorderProblemCode, string>> = {
    DENIED: 'Permission to use the device was denied.',
    NO_DEVICE: 'No microphone or camera is available.',
    DEVICE_BUSY: 'The device is in use by another app.',
    UNSUPPORTED: 'This browser cannot record from the requested source.',
    NO_DATA: 'No recorded data arrived for too long.',
    SILENCE: 'The input stayed silent for too long.',
    INTERRUPTED: 'The recording was interrupted.',
    EMPTY: 'The recording ended without enough data to play.',
    NOT_JOINED: 'The recording segments could not be joined into one file.',
    STORAGE_FULL: 'The device has no room left to store the recording.',
};

class RecorderError extends Error {
    readonly code: RecorderProblemCode;

    constructor(code: RecorderProblemCode, message?: string, options?: { cause?: unknown }) {
        super(message ?? DEFAULT_MESSAGES[code], options);
        this.name = 'RecorderError';
        this.code = code;
    }
}

function isRecorderError(value: unknown): value is RecorderError {
    return value instanceof RecorderError;
}

export { RECORDER_PROBLEM_CODES, RecorderError, isRecorderError };
export type { RecorderProblemCode };
