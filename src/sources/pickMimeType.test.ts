import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubMediaRecorder, stubMissingMediaRecorder } from '../../test/helpers/fakeMedia';
import { baseMimeType, extensionForMimeType, pickMimeType } from './pickMimeType';

const BASE_TYPE_CASES: [string, string][] = [
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
    ['audio/ogg', 'audio/ogg'],
];

const EXTENSION_CASES: [string, string][] = [
    ['audio/webm;codecs=opus', 'webm'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['audio/mp4;codecs=mp4a.40.2', 'm4a'],
    ['audio/mp4', 'm4a'],
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mpeg', 'mp3'],
    ['video/quicktime', 'webm'],
];

describe('pickMimeType', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the preferred type when the browser supports it, even if it is not in the list', () => {
        stubMediaRecorder({ supportedTypes: ['audio/ogg;codecs=vorbis', 'audio/webm;codecs=opus'] });

        expect(pickMimeType(false, 'audio/ogg;codecs=vorbis'))
            .toBe('audio/ogg;codecs=vorbis');
    });

    it('ignores an unsupported preferred type and uses the list', () => {
        stubMediaRecorder({ supportedTypes: ['audio/mp4'] });

        expect(pickMimeType(false, 'audio/ogg;codecs=vorbis'))
            .toBe('audio/mp4');
    });

    it('returns the first supported audio type in list order, not in the order the browser lists them', () => {
        stubMediaRecorder({ supportedTypes: ['audio/mp4', 'audio/webm;codecs=opus'] });

        expect(pickMimeType(false))
            .toBe('audio/webm;codecs=opus');
    });

    it('uses the video list when a video track is expected', () => {
        stubMediaRecorder({ supportedTypes: ['audio/webm;codecs=opus', 'video/mp4'] });

        expect(pickMimeType(true))
            .toBe('video/mp4');
    });

    it('returns the first supported video type in list order', () => {
        stubMediaRecorder({ supportedTypes: ['video/webm', 'video/webm;codecs=vp8,opus'] });

        expect(pickMimeType(true))
            .toBe('video/webm;codecs=vp8,opus');
    });

    it('returns undefined when no type is supported', () => {
        stubMediaRecorder({ supportedTypes: [] });

        expect(pickMimeType(false))
            .toBeUndefined();
        expect(pickMimeType(true))
            .toBeUndefined();
    });

    it('returns undefined when MediaRecorder is missing, even with a preferred type', () => {
        stubMissingMediaRecorder();

        expect(pickMimeType(true, 'video/mp4'))
            .toBeUndefined();
    });

    it('treats a throwing isTypeSupported as unsupported and keeps going', () => {
        stubMediaRecorder({
            isTypeSupported: (mimeType: string): boolean => {
                if (mimeType === 'audio/webm;codecs=opus') {
                    throw new Error('old browser');
                }

                return mimeType === 'audio/webm';
            },
        });

        expect(pickMimeType(false, 'audio/webm;codecs=opus'))
            .toBe('audio/webm');
    });

    it('returns undefined when isTypeSupported throws for every type', () => {
        stubMediaRecorder({
            isTypeSupported: (): boolean => {
                throw new Error('old browser');
            },
        });

        expect(pickMimeType(true, 'video/mp4'))
            .toBeUndefined();
    });
});

describe('baseMimeType', () => {
    it.each(BASE_TYPE_CASES)('strips the codec parameters from %s', (mimeType, expected) => {
        expect(baseMimeType(mimeType))
            .toBe(expected);
    });

    it('trims spaces and lower-cases the type', () => {
        expect(baseMimeType('  Audio/WebM ; codecs=opus '))
            .toBe('audio/webm');
    });
});

describe('extensionForMimeType', () => {
    it.each(EXTENSION_CASES)('maps %s to .%s', (mimeType, expected) => {
        expect(extensionForMimeType(mimeType))
            .toBe(expected);
    });
});
