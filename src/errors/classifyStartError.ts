import { isRecorderError } from './RecorderError';
import type { RecorderProblemCode } from './RecorderError';

// Matched on the name property, not on instanceof DOMException, because old
// Chrome versions throw plain objects named DevicesNotFoundError and TrackStartError.
const CODE_BY_ERROR_NAME = new Map<string, RecorderProblemCode>([
    ['NotAllowedError', 'DENIED'],
    ['SecurityError', 'DENIED'],
    ['NotFoundError', 'NO_DEVICE'],
    ['OverconstrainedError', 'NO_DEVICE'],
    ['DevicesNotFoundError', 'NO_DEVICE'],
    ['NotReadableError', 'DEVICE_BUSY'],
    ['TrackStartError', 'DEVICE_BUSY'],
    ['AbortError', 'DEVICE_BUSY'],
    ['NotSupportedError', 'UNSUPPORTED'],
    ['TypeError', 'UNSUPPORTED'],
    ['QuotaExceededError', 'STORAGE_FULL'],
]);

function readErrorName(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('name' in error)) {
        return '';
    }

    return typeof error.name === 'string' ? error.name : '';
}

function classifyStartError(error: unknown): RecorderProblemCode {
    if (isRecorderError(error)) {
        return error.code;
    }

    const errorName = readErrorName(error);
    const problemCode = CODE_BY_ERROR_NAME.get(errorName);

    return problemCode ?? 'INTERRUPTED';
}

export { classifyStartError };
