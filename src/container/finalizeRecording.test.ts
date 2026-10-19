// @vitest-environment node
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/loadFixture';
import { finalizeRecording } from './finalizeRecording';
import { readDuration } from './readDuration';

const WEBM_FIXTURES: [string, string][] = [
    ['voice-part-1.webm', 'audio/webm'],
    ['voice-part-2.webm', 'audio/webm'],
    ['video-part-1.webm', 'video/webm'],
    ['video-part-2.webm', 'video/webm'],
];

const PASS_THROUGH_FIXTURES: [string, string][] = [
    ['voice-aac-part-1.m4a', 'audio/mp4'],
    ['video-part-1.mp4', 'video/mp4'],
];

async function readHeaderDuration(recording: Blob): Promise<number | null> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(recording),
    });

    try {
        return await input.getDurationFromMetadata();
    } finally {
        input.dispose();
    }
}

describe('finalizeRecording', () => {
    it('writes the duration header that Chrome leaves out of a WebM voice part', async () => {
        const recording = await loadFixture('voice-part-1.webm', 'audio/webm');

        const finalized = await finalizeRecording(recording, 'audio/webm');
        const headerSeconds = await readHeaderDuration(finalized);

        expect(await readHeaderDuration(recording))
            .toBeNull();
        expect(Number.isFinite(headerSeconds))
            .toBe(true);
    });

    it.each(WEBM_FIXTURES)('keeps the duration of %s', async (fileName, mimeType) => {
        const recording = await loadFixture(fileName, mimeType);

        const finalized = await finalizeRecording(recording, mimeType);
        const originalSeconds = await readDuration(recording);
        const finalizedSeconds = await readDuration(finalized);

        expect(Number.isFinite(await readHeaderDuration(finalized)))
            .toBe(true);
        expect(finalizedSeconds)
            .toBeCloseTo(originalSeconds as number, 1);
    });

    it.each(PASS_THROUGH_FIXTURES)('returns the same Blob for %s', async (fileName, mimeType) => {
        const recording = await loadFixture(fileName, mimeType);

        await expect(finalizeRecording(recording, mimeType)).resolves.toBe(recording);
    });

    it('returns the original Blob when remuxing fails', async () => {
        const noise = new Blob([crypto.getRandomValues(new Uint8Array(4096))], { type: 'audio/webm' });

        await expect(finalizeRecording(noise, 'audio/webm')).resolves.toBe(noise);
    });
});
