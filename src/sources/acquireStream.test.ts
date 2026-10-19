import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecorderError, isRecorderError } from '../errors/RecorderError';
import {
    FakeMediaStreamTrack,
    createFakeStream,
    stubMediaDevices,
    stubMediaRecorder,
    stubMissingMediaRecorder,
    stubNavigatorWithoutMediaDevices,
} from '../../test/helpers/fakeMedia';
import {
    DEFAULT_AUDIO_CONSTRAINTS,
    DEFAULT_VIDEO_CONSTRAINTS,
    acquireStream,
    isRecordingSupported,
    releaseStream,
    streamHasVideo,
} from './acquireStream';
import type { AcquiredStream } from './sourceTypes';

const USER_MEDIA_SOURCES: ('audio' | 'video')[] = ['audio', 'video'];

// Waits for a promise to reject and returns the reason. Fails if it resolves.
async function captureRejection(attempt: Promise<unknown>): Promise<unknown> {
    try {
        await attempt;
    } catch (error) {
        return error;
    }

    throw new Error('Expected the promise to reject');
}

describe('isRecordingSupported', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('defaults to the audio source', () => {
        stubMediaRecorder();
        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([]) } });

        expect(isRecordingSupported())
            .toBe(true);
    });

    it('is false when MediaRecorder is missing', () => {
        stubMissingMediaRecorder();
        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([]) } });

        expect(isRecordingSupported('audio'))
            .toBe(false);
    });

    it.each(USER_MEDIA_SOURCES)('needs getUserMedia for the %s source', (source) => {
        stubMediaRecorder();
        stubMediaDevices({});

        expect(isRecordingSupported(source))
            .toBe(false);
    });

    it('needs getDisplayMedia for the screen source, not getUserMedia', () => {
        stubMediaRecorder();
        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([]) } });

        expect(isRecordingSupported('screen'))
            .toBe(false);
    });

    it('is true for the screen source when getDisplayMedia exists', () => {
        stubMediaRecorder();
        stubMediaDevices({ getDisplayMedia: { resolve: createFakeStream([]) } });

        expect(isRecordingSupported('screen'))
            .toBe(true);
    });

    it('is true for an app provided stream when MediaRecorder exists, with no mediaDevices', () => {
        stubMediaRecorder();
        stubNavigatorWithoutMediaDevices();

        expect(isRecordingSupported(createFakeStream([])))
            .toBe(true);
    });

    it('is false for an app provided stream when MediaRecorder is missing', () => {
        stubMissingMediaRecorder();

        expect(isRecordingSupported(createFakeStream([])))
            .toBe(false);
    });
});

describe('default constraints', () => {
    it('captures mono audio with echo cancellation and noise suppression', () => {
        expect(DEFAULT_AUDIO_CONSTRAINTS)
            .toEqual({ channelCount: 1, echoCancellation: true, noiseSuppression: true });
    });

    it('asks for 1280x720 at 30 frames per second', () => {
        expect(DEFAULT_VIDEO_CONSTRAINTS)
            .toEqual({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
    });
});

describe('acquireStream', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('asks getUserMedia for default audio when the source is audio', async () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('audio')]);
        const devices = stubMediaDevices({ getUserMedia: { resolve: stream } });

        const acquired = await acquireStream({ source: 'audio' });

        expect(devices.getUserMedia)
            .toHaveBeenCalledWith({ audio: DEFAULT_AUDIO_CONSTRAINTS, video: false });
        expect(acquired)
            .toEqual({ stream, kind: 'audio', ownsStream: true });
    });

    it('uses the caller audio constraints instead of the defaults', async () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('audio')]);
        const devices = stubMediaDevices({ getUserMedia: { resolve: stream } });

        await acquireStream({ source: 'audio', audio: { deviceId: 'mic-2' } });

        expect(devices.getUserMedia)
            .toHaveBeenCalledWith({ audio: { deviceId: 'mic-2' }, video: false });
    });

    it('asks getUserMedia for default audio and video when the source is video', async () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('audio'), new FakeMediaStreamTrack('video')]);
        const devices = stubMediaDevices({ getUserMedia: { resolve: stream } });

        const acquired = await acquireStream({ source: 'video' });

        expect(devices.getUserMedia)
            .toHaveBeenCalledWith({ audio: DEFAULT_AUDIO_CONSTRAINTS, video: DEFAULT_VIDEO_CONSTRAINTS });
        expect(acquired)
            .toEqual({ stream, kind: 'video', ownsStream: true });
    });

    it('asks getDisplayMedia with audio and video true for the screen source', async () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('video'), new FakeMediaStreamTrack('audio')]);
        const devices = stubMediaDevices({ getDisplayMedia: { resolve: stream } });

        const acquired = await acquireStream({ source: 'screen' });

        expect(devices.getDisplayMedia)
            .toHaveBeenCalledWith({ audio: true, video: true });
        expect(acquired)
            .toEqual({ stream, kind: 'screen', ownsStream: true });
    });

    it('passes the display constraints through as given', async () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('video')]);
        const devices = stubMediaDevices({ getDisplayMedia: { resolve: stream } });

        await acquireStream({ source: 'screen', audio: false });

        expect(devices.getDisplayMedia)
            .toHaveBeenCalledWith({ audio: false, video: true });
    });

    it('does not require an audio track for the screen source', async () => {
        const videoTrack = new FakeMediaStreamTrack('video');
        const stream = createFakeStream([videoTrack]);

        stubMediaDevices({ getDisplayMedia: { resolve: stream } });

        const acquired = await acquireStream({ source: 'screen' });

        expect(acquired.stream)
            .toBe(stream);
        expect(videoTrack.stopCount)
            .toBe(0);
    });

    it('returns an app provided stream as is, without calling any device API', async () => {
        const appStream = createFakeStream([new FakeMediaStreamTrack('audio')]);
        const devices = stubMediaDevices({ getUserMedia: { resolve: createFakeStream([]) } });

        const acquired = await acquireStream({ source: appStream, audio: false, video: true });

        expect(devices.getUserMedia).not.toHaveBeenCalled();
        expect(acquired)
            .toEqual({ stream: appStream, kind: 'stream', ownsStream: false });
    });

    it('does not need mediaDevices for an app provided stream', async () => {
        const appStream = createFakeStream([]);

        stubNavigatorWithoutMediaDevices();

        const acquired = await acquireStream({ source: appStream });

        expect(acquired.stream)
            .toBe(appStream);
        expect(acquired.kind)
            .toBe('stream');
    });

    it.each(USER_MEDIA_SOURCES)('rejects with UNSUPPORTED when getUserMedia is missing for %s', async (source) => {
        stubMediaDevices({});

        const reason = await captureRejection(acquireStream({ source }));

        expect(isRecorderError(reason))
            .toBe(true);
        expect(reason)
            .toMatchObject({ code: 'UNSUPPORTED' });
    });

    it('rejects with UNSUPPORTED when getDisplayMedia is missing for the screen source', async () => {
        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([]) } });

        const reason = await captureRejection(acquireStream({ source: 'screen' }));

        expect(reason)
            .toBeInstanceOf(RecorderError);
        expect(reason)
            .toMatchObject({ code: 'UNSUPPORTED' });
    });

    it('rethrows the browser error from getUserMedia unchanged', async () => {
        const denied = new DOMException('Permission denied', 'NotAllowedError');

        stubMediaDevices({ getUserMedia: { reject: denied } });

        await expect(acquireStream({ source: 'audio' })).rejects.toBe(denied);
    });

    it('rethrows the browser error from getDisplayMedia unchanged', async () => {
        const cancelled = new DOMException('The user cancelled the share.', 'AbortError');

        stubMediaDevices({ getDisplayMedia: { reject: cancelled } });

        await expect(acquireStream({ source: 'screen' })).rejects.toBe(cancelled);
    });

    it('rejects with NO_DEVICE and stops the video track when an audio source has no audio track', async () => {
        const videoTrack = new FakeMediaStreamTrack('video');

        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([videoTrack]) } });

        const reason = await captureRejection(acquireStream({ source: 'audio' }));

        expect(reason)
            .toBeInstanceOf(RecorderError);
        expect(reason)
            .toMatchObject({ code: 'NO_DEVICE' });
        expect(videoTrack.stopCount)
            .toBe(1);
    });

    it('rejects with NO_DEVICE and stops the audio track when a video source has no video track', async () => {
        const audioTrack = new FakeMediaStreamTrack('audio');

        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([audioTrack]) } });

        const reason = await captureRejection(acquireStream({ source: 'video' }));

        expect(reason)
            .toBeInstanceOf(RecorderError);
        expect(reason)
            .toMatchObject({ code: 'NO_DEVICE' });
        expect(audioTrack.stopCount)
            .toBe(1);
    });

    it('keeps the tracks of a stream that has what the source needs', async () => {
        const audioTrack = new FakeMediaStreamTrack('audio');
        const videoTrack = new FakeMediaStreamTrack('video');

        stubMediaDevices({ getUserMedia: { resolve: createFakeStream([audioTrack, videoTrack]) } });

        await acquireStream({ source: 'video' });

        expect(audioTrack.stopCount)
            .toBe(0);
        expect(videoTrack.stopCount)
            .toBe(0);
    });
});

describe('releaseStream', () => {
    it('stops every track of a stream the library owns', () => {
        const audioTrack = new FakeMediaStreamTrack('audio');
        const videoTrack = new FakeMediaStreamTrack('video');
        const acquired: AcquiredStream = {
            stream: createFakeStream([audioTrack, videoTrack]),
            kind: 'video',
            ownsStream: true,
        };

        releaseStream(acquired);

        expect(audioTrack.stopCount)
            .toBe(1);
        expect(videoTrack.stopCount)
            .toBe(1);
    });

    it('leaves the tracks of an app provided stream running', () => {
        const track = new FakeMediaStreamTrack('audio');
        const acquired: AcquiredStream = {
            stream: createFakeStream([track]),
            kind: 'stream',
            ownsStream: false,
        };

        releaseStream(acquired);

        expect(track.stopCount)
            .toBe(0);
    });

    it('does not throw when a track stop throws, and still stops the other tracks', () => {
        const failing = new FakeMediaStreamTrack('audio', { stopError: new Error('stop failed') });
        const other = new FakeMediaStreamTrack('video');
        const acquired: AcquiredStream = {
            stream: createFakeStream([failing, other]),
            kind: 'video',
            ownsStream: true,
        };

        expect(() => {
            releaseStream(acquired);
        }).not.toThrow();
        expect(failing.stopCount)
            .toBe(1);
        expect(other.stopCount)
            .toBe(1);
    });
});

describe('streamHasVideo', () => {
    it('is true when the stream has a video track', () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('audio'), new FakeMediaStreamTrack('video')]);

        expect(streamHasVideo(stream))
            .toBe(true);
    });

    it('is false for an audio only stream', () => {
        const stream = createFakeStream([new FakeMediaStreamTrack('audio')]);

        expect(streamHasVideo(stream))
            .toBe(false);
    });

    it('is false for a stream with no tracks', () => {
        expect(streamHasVideo(createFakeStream([])))
            .toBe(false);
    });
});
