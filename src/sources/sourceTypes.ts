import type { RecordingSourceKind } from '../storage/storageTypes';

type RecordingSource = 'audio' | 'video' | 'screen' | MediaStream;

interface StreamRequest {
    source: RecordingSource;
    // true means the default constraints. false means no track of that kind.
    audio?: MediaTrackConstraints | boolean;
    video?: MediaTrackConstraints | boolean;
}

interface AcquiredStream {
    stream: MediaStream;
    // 'stream' when the app passed its own MediaStream.
    kind: RecordingSourceKind;
    // False for an app provided stream. Its tracks are never stopped by us.
    ownsStream: boolean;
}

export type { AcquiredStream, RecordingSource, StreamRequest };
