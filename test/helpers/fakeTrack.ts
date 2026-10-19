// Fake MediaStreamTrack and MediaStream for monitor tests. Only the members
// the monitors read are modeled. Pass a fake stream through asMediaStream
// when the code under test needs a MediaStream.

type FakeTrackKind = 'audio' | 'video';

interface FakeTrackOptions {
    kind?: FakeTrackKind;
}

let createdTrackCount = 0;

class FakeMediaStreamTrack extends EventTarget {
    readonly id: string;
    readonly kind: FakeTrackKind;
    muted: boolean;
    readyState: MediaStreamTrackState;

    constructor(kind: FakeTrackKind) {
        super();

        createdTrackCount += 1;
        this.id = `fake-track-${String(createdTrackCount)}`;
        this.kind = kind;
        this.muted = false;
        this.readyState = 'live';
    }

    // Like a browser, the 'ended' event is fired by the source, not by stop().
    fireEnded(): void {
        this.readyState = 'ended';
        this.dispatchEvent(new Event('ended'));
    }

    fireMute(): void {
        this.muted = true;
        this.dispatchEvent(new Event('mute'));
    }

    fireUnmute(): void {
        this.muted = false;
        this.dispatchEvent(new Event('unmute'));
    }

    // Like a browser, stop() ends the track without firing 'ended'.
    stop(): void {
        this.readyState = 'ended';
    }
}

class FakeMediaStream {
    readonly id: string;
    private readonly tracks: FakeMediaStreamTrack[];

    constructor(tracks: FakeMediaStreamTrack[]) {
        createdTrackCount += 1;
        this.id = `fake-stream-${String(createdTrackCount)}`;
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

function createFakeTrack(options: FakeTrackOptions = {}): FakeMediaStreamTrack {
    const kind = options.kind ?? 'audio';

    return new FakeMediaStreamTrack(kind);
}

function createFakeStream(...tracks: FakeMediaStreamTrack[]): FakeMediaStream {
    return new FakeMediaStream(tracks);
}

function asMediaStream(stream: FakeMediaStream): MediaStream {
    return stream as unknown as MediaStream;
}

export { asMediaStream, createFakeStream, createFakeTrack, FakeMediaStream, FakeMediaStreamTrack };
export type { FakeTrackKind, FakeTrackOptions };
