import { RecorderError } from '../errors/RecorderError';
import type { AcquiredStream, RecordingSource, StreamRequest } from './sourceTypes';

type CaptureSource = Exclude<RecordingSource, MediaStream>;

const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
};

const DEFAULT_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
};

function readMediaDevices(): MediaDevices | undefined {
    if (typeof navigator === 'undefined') {
        return undefined;
    }

    // The DOM types say this is always present. It is missing outside a secure
    // context, so it is typed as optional here.
    const mediaDevices: MediaDevices | undefined = navigator.mediaDevices;

    return mediaDevices;
}

function hasCaptureMethod(mediaDevices: MediaDevices | undefined, source: CaptureSource): boolean {
    if (source === 'screen') {
        return typeof mediaDevices?.getDisplayMedia === 'function';
    }

    return typeof mediaDevices?.getUserMedia === 'function';
}

function isRecordingSupported(source: RecordingSource = 'audio'): boolean {
    if (typeof MediaRecorder === 'undefined') {
        return false;
    }

    if (typeof source !== 'string') {
        return true;
    }

    const mediaDevices = readMediaDevices();

    return hasCaptureMethod(mediaDevices, source);
}

function stopTracks(stream: MediaStream): void {
    stream.getTracks()
        .forEach((track) => {
            try {
                track.stop();
            } catch {
                // One track that fails to stop must not keep the other tracks running.
            }
        });
}

function requestUserMedia(
    mediaDevices: MediaDevices,
    audio: MediaTrackConstraints | boolean,
    video: MediaTrackConstraints | boolean,
): Promise<MediaStream> {
    const audioConstraints = audio === true ? DEFAULT_AUDIO_CONSTRAINTS : audio;
    const videoConstraints = video === true ? DEFAULT_VIDEO_CONSTRAINTS : video;

    return mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
    });
}

// Display capture constraints differ from camera constraints, so `true` is
// passed through as is.
function requestDisplayMedia(
    mediaDevices: MediaDevices,
    audio: MediaTrackConstraints | boolean,
    video: MediaTrackConstraints | boolean,
): Promise<MediaStream> {
    return mediaDevices.getDisplayMedia({
        audio,
        video,
    });
}

function streamHasVideo(stream: MediaStream): boolean {
    return stream.getVideoTracks().length > 0;
}

function hasRequiredTrack(stream: MediaStream, source: CaptureSource): boolean {
    if (source === 'audio') {
        return stream.getAudioTracks().length > 0;
    }

    if (source === 'video') {
        return streamHasVideo(stream);
    }

    return true;
}

async function acquireStream(request: StreamRequest): Promise<AcquiredStream> {
    const { source } = request;

    if (typeof source !== 'string') {
        return { stream: source, kind: 'stream', ownsStream: false };
    }

    const mediaDevices = readMediaDevices();

    if (!mediaDevices || !hasCaptureMethod(mediaDevices, source)) {
        throw new RecorderError('UNSUPPORTED');
    }

    // Screen capture takes audio and video by default. Camera and microphone
    // capture takes video only when asked for it.
    const isVideoByDefault = source !== 'audio';
    const audioOption = request.audio ?? true;
    const videoOption = request.video ?? isVideoByDefault;
    const stream = source === 'screen'
        ? await requestDisplayMedia(mediaDevices, audioOption, videoOption)
        : await requestUserMedia(mediaDevices, audioOption, videoOption);

    if (!hasRequiredTrack(stream, source)) {
        stopTracks(stream);

        throw new RecorderError('NO_DEVICE');
    }

    return { stream, kind: source, ownsStream: true };
}

function releaseStream(acquired: AcquiredStream): void {
    if (!acquired.ownsStream) {
        return;
    }

    stopTracks(acquired.stream);
}

export {
    DEFAULT_AUDIO_CONSTRAINTS,
    DEFAULT_VIDEO_CONSTRAINTS,
    isRecordingSupported,
    streamHasVideo,
    acquireStream,
    releaseStream,
};
