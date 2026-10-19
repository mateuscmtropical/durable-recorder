import { describe, it, expect } from 'vitest';
import { RecorderError, RECORDER_PROBLEM_CODES, isRecorderError } from './RecorderError';

describe('RECORDER_PROBLEM_CODES', () => {
    it('lists the ten problem codes in order', () => {
        expect(RECORDER_PROBLEM_CODES)
            .toEqual([
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
            ]);
    });
});

describe('RecorderError', () => {
    it('has the name RecorderError', () => {
        const error = new RecorderError('DENIED');

        expect(error.name)
            .toBe('RecorderError');
    });

    it('is an Error that carries the problem code', () => {
        const error = new RecorderError('NO_DEVICE');

        expect(error)
            .toBeInstanceOf(Error);
        expect(error)
            .toBeInstanceOf(RecorderError);
        expect(error.code)
            .toBe('NO_DEVICE');
    });

    it('uses the message it is given', () => {
        const error = new RecorderError('DENIED', 'Custom message.');

        expect(error.message)
            .toBe('Custom message.');
    });

    it('uses the DENIED default message when no message is given', () => {
        const error = new RecorderError('DENIED');

        expect(error.message)
            .toBe('Permission to use the device was denied.');
    });

    it.each(RECORDER_PROBLEM_CODES)('has a default sentence for %s', (code) => {
        const error = new RecorderError(code);

        expect(error.message)
            .toMatch(/^[A-Z].*\.$/);
    });

    it('gives each code its own default message', () => {
        const defaultMessages = RECORDER_PROBLEM_CODES.map(code => new RecorderError(code).message);

        expect(new Set(defaultMessages).size)
            .toBe(RECORDER_PROBLEM_CODES.length);
    });

    it('passes the cause to Error so error.cause works', () => {
        const originalError = new DOMException('The device is in use.', 'NotReadableError');
        const error = new RecorderError('DEVICE_BUSY', undefined, { cause: originalError });

        expect(error.cause)
            .toBe(originalError);
    });

    it('accepts a cause that is not an Error', () => {
        const error = new RecorderError('INTERRUPTED', undefined, { cause: 'raw failure' });

        expect(error.cause)
            .toBe('raw failure');
    });

    it('has no cause when none is given', () => {
        const error = new RecorderError('EMPTY');

        expect(error.cause)
            .toBeUndefined();
    });
});

describe('isRecorderError', () => {
    it('returns true for a RecorderError', () => {
        expect(isRecorderError(new RecorderError('STORAGE_FULL')))
            .toBe(true);
    });

    it('returns false for other values', () => {
        expect(isRecorderError(new Error('plain error')))
            .toBe(false);
        expect(isRecorderError(new DOMException('Denied.', 'NotAllowedError')))
            .toBe(false);
        expect(isRecorderError({ code: 'DENIED' }))
            .toBe(false);
        expect(isRecorderError('DENIED'))
            .toBe(false);
        expect(isRecorderError(null))
            .toBe(false);
        expect(isRecorderError(undefined))
            .toBe(false);
    });
});
