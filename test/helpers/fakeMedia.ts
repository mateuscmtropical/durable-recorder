import { vi } from 'vitest';
import type { Mock } from 'vitest';

type TrackKind = 'audio' | 'video';

interface FakeTrackOptions {
    // When set, stop() throws this error after the track is marked as ended.
    stopError?: Error;
}

interface MediaRecorderStubOptions {
    supportedTypes?: readonly string[];
    isTypeSupported?: (mimeType: string) => boolean;
}

// A resolved stream or a rejected error for one getUserMedia or getDisplayMedia call.
type DeviceCallOutcome = { resolve: MediaStream } | { reject: Error };

interface MediaDevicesStubOptions {
    getUserMedia?: DeviceCallOutcome;
    getDisplayMedia?: DeviceCallOutcome;
}

interface MediaDevicesStub {
    getUserMedia?: Mock<() => Promise<MediaStream>>;
    getDisplayMedia?: Mock<() => Promise<MediaStream>>;
}

// A MediaStreamTrack that counts how often it was stopped.
class FakeMediaStreamTrack {
    readonly kind: TrackKind;
    readyState: 'live' | 'ended' = 'live';
    stopCount = 0;
    private readonly stopError: Error | undefined;

    constructor(kind: TrackKind, options: FakeTrackOptions = {}) {
        this.kind = kind;
        this.stopError = options.stopError;
    }

    stop(): void {
        this.stopCount += 1;
        this.readyState = 'ended';

        if (this.stopError) {
            throw this.stopError;
        }
    }
}

// A MediaStream with the getters the library reads. It holds the tracks it was given.
class FakeMediaStream {
    private readonly tracks: FakeMediaStreamTrack[];

    constructor(tracks: FakeMediaStreamTrack[]) {
        this.tracks = [...tracks];
    }

    getTracks(): FakeMediaStreamTrack[] {
        return [...this.tracks];
    }

    getAudioTracks(): FakeMediaStreamTrack[] {
        return this.tracks.filter(track => track.kind === 'audio');
    }

    getVideoTracks(): FakeMediaStreamTrack[] {
        return this.tracks.filter(track => track.kind === 'video');
    }
}

function createFakeStream(tracks: FakeMediaStreamTrack[]): MediaStream {
    const stream = new FakeMediaStream(tracks);

    return stream as unknown as MediaStream;
}

// Installs a MediaRecorder global. Its isTypeSupported answers from supportedTypes,
// unless a custom isTypeSupported is given.
function stubMediaRecorder(options: MediaRecorderStubOptions = {}): Mock<(mimeType: string) => boolean> {
    const supportedTypes = options.supportedTypes ?? [];
    const answer = options.isTypeSupported ?? ((mimeType: string): boolean => supportedTypes.includes(mimeType));
    const isTypeSupported = vi.fn(answer);

    vi.stubGlobal('MediaRecorder', { isTypeSupported });

    return isTypeSupported;
}

// Leaves MediaRecorder undefined, the same as in a browser without the API.
function stubMissingMediaRecorder(): void {
    vi.stubGlobal('MediaRecorder', undefined);
}

function answerDeviceCall(outcome: DeviceCallOutcome): Promise<MediaStream> {
    if ('reject' in outcome) {
        return Promise.reject(outcome.reject);
    }

    return Promise.resolve(outcome.resolve);
}

// Installs navigator.mediaDevices with only the methods given. A method that is
// not given stays missing, so feature checks see it as unsupported.
function stubMediaDevices(options: MediaDevicesStubOptions): MediaDevicesStub {
    const stub: MediaDevicesStub = {};

    if (options.getUserMedia) {
        const outcome = options.getUserMedia;

        stub.getUserMedia = vi.fn(() => answerDeviceCall(outcome));
    }

    if (options.getDisplayMedia) {
        const outcome = options.getDisplayMedia;

        stub.getDisplayMedia = vi.fn(() => answerDeviceCall(outcome));
    }

    vi.stubGlobal('navigator', { mediaDevices: stub });

    return stub;
}

// Installs a navigator object that has no mediaDevices at all.
function stubNavigatorWithoutMediaDevices(): void {
    vi.stubGlobal('navigator', {});
}

export { FakeMediaStreamTrack, createFakeStream, stubMediaRecorder, stubMissingMediaRecorder, stubMediaDevices, stubNavigatorWithoutMediaDevices };
export type { DeviceCallOutcome, FakeTrackOptions, MediaDevicesStub, MediaDevicesStubOptions, MediaRecorderStubOptions, TrackKind };
