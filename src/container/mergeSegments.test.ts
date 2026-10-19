// @vitest-environment node
import { ALL_FORMATS, BlobSource, EncodedAudioPacketSource, Input } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { loadFixture } from '../../test/helpers/loadFixture';
import { mergeSegments } from './mergeSegments';
import { readDuration } from './readDuration';

const WEBM_AUDIO = 'audio/webm;codecs=opus';
const MP4_AUDIO = 'audio/mp4;codecs=mp4a.40.2';
const WEBM_VIDEO = 'video/webm;codecs=vp8,opus';
const MP4_VIDEO = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';

interface TrackSummary {
    audioCodec: string | null;
    videoCodec: string | null;
    videoWidth: number | null;
    videoHeight: number | null;
}

interface JoinCase {
    description: string;
    fileNames: [string, string];
    mimeType: string;
    expectedType: string;
    expectedTracks: TrackSummary;
}

const JOIN_CASES: JoinCase[] = [
    {
        description: 'two Chrome WebM voice parts',
        fileNames: ['voice-part-1.webm', 'voice-part-2.webm'],
        mimeType: WEBM_AUDIO,
        expectedType: 'audio/webm',
        expectedTracks: { audioCodec: 'opus', videoCodec: null, videoWidth: null, videoHeight: null },
    },
    {
        description: 'two iPhone style AAC parts',
        fileNames: ['voice-aac-part-1.m4a', 'voice-aac-part-2.m4a'],
        mimeType: MP4_AUDIO,
        expectedType: 'audio/mp4',
        expectedTracks: { audioCodec: 'aac', videoCodec: null, videoWidth: null, videoHeight: null },
    },
    {
        description: 'two WebM video parts with VP8 and Opus',
        fileNames: ['video-part-1.webm', 'video-part-2.webm'],
        mimeType: WEBM_VIDEO,
        expectedType: 'video/webm',
        expectedTracks: { audioCodec: 'opus', videoCodec: 'vp8', videoWidth: 160, videoHeight: 120 },
    },
    {
        description: 'two MP4 video parts with H.264 and AAC',
        fileNames: ['video-part-1.mp4', 'video-part-2.mp4'],
        mimeType: MP4_VIDEO,
        expectedType: 'video/mp4',
        expectedTracks: { audioCodec: 'aac', videoCodec: 'avc', videoWidth: 160, videoHeight: 120 },
    },
];

async function summarizeTracks(recording: Blob): Promise<TrackSummary> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(recording),
    });

    try {
        const audioTrack = await input.getPrimaryAudioTrack();
        const videoTrack = await input.getPrimaryVideoTrack();
        const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
        const videoCodec = videoTrack ? await videoTrack.getCodec() : null;
        const videoWidth = videoTrack ? await videoTrack.getCodedWidth() : null;
        const videoHeight = videoTrack ? await videoTrack.getCodedHeight() : null;

        return {
            audioCodec,
            videoCodec,
            videoWidth,
            videoHeight,
        };
    } finally {
        input.dispose();
    }
}

async function requireDuration(recording: Blob): Promise<number> {
    const seconds = await readDuration(recording);

    if (seconds === null) {
        throw new Error('Expected a readable duration');
    }

    return seconds;
}

function requireRecording(recording: Blob | null): Blob {
    if (recording === null) {
        throw new Error('Expected a merged recording, got null');
    }

    return recording;
}

async function readText(recording: Blob): Promise<string> {
    const bytes = await recording.arrayBuffer();

    return new TextDecoder('latin1')
        .decode(bytes);
}

describe('mergeSegments', () => {
    it('returns null when there are no segments', async () => {
        await expect(mergeSegments([], WEBM_AUDIO)).resolves.toBeNull();
    });

    it('returns the same Blob when there is only one segment', async () => {
        const part = await loadFixture('voice-part-1.webm', 'audio/webm');

        await expect(mergeSegments([part], WEBM_AUDIO)).resolves.toBe(part);
    });

    it('returns null for a MIME type it cannot write', async () => {
        const first = await loadFixture('voice-part-1.webm', 'audio/webm');
        const second = await loadFixture('voice-part-2.webm', 'audio/webm');

        await expect(mergeSegments([first, second], 'audio/wav')).resolves.toBeNull();
    });

    it.each(JOIN_CASES)('joins $description into one longer file', async ({ fileNames, mimeType, expectedType, expectedTracks }) => {
        const [firstName, secondName] = fileNames;
        const first = await loadFixture(firstName, mimeType);
        const second = await loadFixture(secondName, mimeType);
        const firstSeconds = await requireDuration(first);
        const secondSeconds = await requireDuration(second);

        const merged = requireRecording(await mergeSegments([first, second], mimeType));
        const mergedSeconds = await requireDuration(merged);
        const mergedTracks = await summarizeTracks(merged);

        expect(merged.type)
            .toBe(expectedType);
        expect(mergedTracks)
            .toEqual(expectedTracks);
        expect(mergedSeconds)
            .toBeGreaterThan(Math.max(firstSeconds, secondSeconds));
        expect(Math.abs(mergedSeconds - (firstSeconds + secondSeconds)))
            .toBeLessThan(0.5);
    });

    it('writes the MP4 index before the media data so it plays progressively', async () => {
        const first = await loadFixture('voice-aac-part-1.m4a', MP4_AUDIO);
        const second = await loadFixture('voice-aac-part-2.m4a', MP4_AUDIO);

        const merged = requireRecording(await mergeSegments([first, second], MP4_AUDIO));
        const text = await readText(merged);

        expect(text.indexOf('moov'))
            .toBeGreaterThan(-1);
        expect(text.indexOf('moov'))
            .toBeLessThan(text.indexOf('mdat'));
    });

    it('returns null when a WebM part is joined with an MP4 part', async () => {
        const webm = await loadFixture('voice-part-1.webm', 'audio/webm');
        const mp4 = await loadFixture('voice-aac-part-1.m4a', MP4_AUDIO);

        await expect(mergeSegments([webm, mp4], WEBM_AUDIO)).resolves.toBeNull();
    });

    it('returns null when an audio-only part is joined with a video part', async () => {
        const audio = await loadFixture('voice-part-1.webm', 'audio/webm');
        const video = await loadFixture('video-part-1.webm', 'video/webm');

        await expect(mergeSegments([audio, video], WEBM_AUDIO)).resolves.toBeNull();
    });

    it('returns null when a part is not a media file', async () => {
        const noise = new Blob([crypto.getRandomValues(new Uint8Array(4096))], { type: 'audio/webm' });
        const second = await loadFixture('voice-part-2.webm', 'audio/webm');

        await expect(mergeSegments([noise, second], WEBM_AUDIO)).resolves.toBeNull();
    });

    it('returns null when copying a packet throws', async () => {
        const first = await loadFixture('voice-part-1.webm', 'audio/webm');
        const second = await loadFixture('voice-part-2.webm', 'audio/webm');

        vi.spyOn(EncodedAudioPacketSource.prototype, 'add')
            .mockRejectedValue(new Error('broken packet'));

        await expect(mergeSegments([first, second], WEBM_AUDIO)).resolves.toBeNull();
    });
});
