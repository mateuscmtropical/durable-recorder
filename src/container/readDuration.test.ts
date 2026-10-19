// @vitest-environment node
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/loadFixture';
import { readDuration } from './readDuration';

const FIXTURE_CASES: [string, string][] = [
    ['voice-part-1.webm', 'audio/webm'],
    ['voice-part-2.webm', 'audio/webm'],
    ['voice-aac-part-1.m4a', 'audio/mp4'],
    ['voice-aac-part-2.m4a', 'audio/mp4'],
    ['video-part-1.webm', 'video/webm'],
    ['video-part-2.webm', 'video/webm'],
    ['video-part-1.mp4', 'video/mp4'],
    ['video-part-2.mp4', 'video/mp4'],
];

const VIDEO_CASES = FIXTURE_CASES.filter(([, mimeType]) => mimeType.startsWith('video/'));

describe('readDuration', () => {
    it.each(FIXTURE_CASES)('reads a positive finite duration from %s', async (fileName, mimeType) => {
        const recording = await loadFixture(fileName, mimeType);

        const seconds = await readDuration(recording);

        expect(Number.isFinite(seconds))
            .toBe(true);
        expect(seconds)
            .toBeGreaterThan(0);
    });

    it.each(VIDEO_CASES)('reads about one second from %s', async (fileName, mimeType) => {
        const recording = await loadFixture(fileName, mimeType);

        const seconds = await readDuration(recording);

        expect(seconds)
            .toBeCloseTo(1, 0);
    });

    it('returns the unrounded duration that mediabunny computes', async () => {
        const recording = await loadFixture('voice-part-1.webm', 'audio/webm');
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BlobSource(recording),
        });

        try {
            const expected = await input.computeDuration();

            await expect(readDuration(recording)).resolves.toBe(expected);
        } finally {
            input.dispose();
        }
    });

    it('returns null for bytes that are not a media file', async () => {
        const noise = new Blob([crypto.getRandomValues(new Uint8Array(4096))], { type: 'audio/webm' });

        await expect(readDuration(noise)).resolves.toBeNull();
    });
});
