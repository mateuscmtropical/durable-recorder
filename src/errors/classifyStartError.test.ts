import { describe, it, expect } from 'vitest';
import { classifyStartError } from './classifyStartError';
import { RecorderError, RECORDER_PROBLEM_CODES } from './RecorderError';
import type { RecorderProblemCode } from './RecorderError';

// Each name is tested both as a DOMException and as a plain object, because
// old Chrome versions throw plain objects with these names.
const NAME_TO_CODE_CASES: [string, RecorderProblemCode][] = [
    ['NotAllowedError', 'DENIED'],
    ['SecurityError', 'DENIED'],
    ['NotFoundError', 'NO_DEVICE'],
    ['OverconstrainedError', 'NO_DEVICE'],
    ['DevicesNotFoundError', 'NO_DEVICE'],
    ['NotReadableError', 'DEVICE_BUSY'],
    ['TrackStartError', 'DEVICE_BUSY'],
    ['AbortError', 'DEVICE_BUSY'],
    ['NotSupportedError', 'UNSUPPORTED'],
    ['QuotaExceededError', 'STORAGE_FULL'],
    ['SomeUnknownError', 'INTERRUPTED'],
];

describe('classifyStartError', () => {
    it.each(RECORDER_PROBLEM_CODES)('returns the code of a RecorderError with code %s', (code) => {
        expect(classifyStartError(new RecorderError(code)))
            .toBe(code);
    });

    it('keeps the code of a RecorderError even when its cause has another name', () => {
        const error = new RecorderError('SILENCE', undefined, {
            cause: new DOMException('Device not found.', 'NotFoundError'),
        });

        expect(classifyStartError(error))
            .toBe('SILENCE');
    });

    it.each(NAME_TO_CODE_CASES)('maps a DOMException named %s to %s', (name, expectedCode) => {
        expect(classifyStartError(new DOMException('Test error.', name)))
            .toBe(expectedCode);
    });

    it.each(NAME_TO_CODE_CASES)('maps a plain object named %s to %s', (name, expectedCode) => {
        expect(classifyStartError({ name, message: 'Test error.' }))
            .toBe(expectedCode);
    });

    it('maps a plain Error by its name property', () => {
        const error = Object.assign(new Error('Test error.'), { name: 'NotAllowedError' });

        expect(classifyStartError(error))
            .toBe('DENIED');
    });

    it('maps a TypeError to UNSUPPORTED', () => {
        expect(classifyStartError(new TypeError('Test error.')))
            .toBe('UNSUPPORTED');
    });

    it('maps a plain Error with no known name to INTERRUPTED', () => {
        expect(classifyStartError(new Error('Test error.')))
            .toBe('INTERRUPTED');
    });

    it('maps other Error subclasses that are not TypeError to INTERRUPTED', () => {
        expect(classifyStartError(new RangeError('Test error.')))
            .toBe('INTERRUPTED');
    });

    it('maps values that are not errors to INTERRUPTED without throwing', () => {
        expect(classifyStartError(undefined))
            .toBe('INTERRUPTED');
        expect(classifyStartError(null))
            .toBe('INTERRUPTED');
        expect(classifyStartError(42))
            .toBe('INTERRUPTED');
        expect(classifyStartError('NotAllowedError'))
            .toBe('INTERRUPTED');
        expect(classifyStartError({ message: 'No name here.' }))
            .toBe('INTERRUPTED');
    });
});
