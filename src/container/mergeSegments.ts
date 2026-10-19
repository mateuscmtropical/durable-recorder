import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    OggOutputFormat,
    Output,
    WebMOutputFormat,
} from 'mediabunny';
import type {
    EncodedPacket,
    InputAudioTrack,
    InputTrack,
    InputVideoTrack,
    OutputFormat,
} from 'mediabunny';

type PacketWriter = (packet: EncodedPacket) => Promise<void>;

interface TrackSet {
    audio: InputAudioTrack | null;
    video: InputVideoTrack | null;
}

interface WriterSet {
    audio: PacketWriter | null;
    video: PacketWriter | null;
}

interface TrackCopy {
    track: InputTrack;
    writePacket: PacketWriter;
}

// Each factory makes a new format, because a format object belongs to one output.
const OUTPUT_FORMAT_FACTORIES = new Map<string, () => OutputFormat>([
    ['audio/webm', () => new WebMOutputFormat()],
    ['video/webm', () => new WebMOutputFormat()],
    // The index goes first, so an MP4 plays while it is still being read.
    ['audio/mp4', () => new Mp4OutputFormat({ fastStart: 'in-memory' })],
    ['video/mp4', () => new Mp4OutputFormat({ fastStart: 'in-memory' })],
    ['audio/ogg', () => new OggOutputFormat()],
]);

export function baseMimeType(mimeType: string): string {
    const withoutParameters = mimeType.replace(/;.*$/, '');

    return withoutParameters.trim();
}

export async function mergeSegments(segments: Blob[], mimeType: string): Promise<Blob | null> {
    const [firstSegment] = segments;
    const type = baseMimeType(mimeType);

    if (!firstSegment || !OUTPUT_FORMAT_FACTORIES.has(type)) {
        return null;
    }

    if (segments.length === 1) {
        return firstSegment;
    }

    return copySegments(segments, mimeType);
}

// Copies the packets of every segment into one new file. Also used alone by
// finalizeRecording to remux a single WebM. Never throws.
export async function copySegments(segments: Blob[], mimeType: string): Promise<Blob | null> {
    const type = baseMimeType(mimeType);
    const createFormat = OUTPUT_FORMAT_FACTORIES.get(type);

    if (!createFormat) {
        return null;
    }

    const inputs = segments.map(createInput);

    try {
        const format = createFormat();
        const buffer = await writeTracks(inputs, format);

        return buffer ? new Blob([buffer], { type }) : null;
    } catch {
        return null;
    } finally {
        inputs.forEach((input) => {
            input.dispose();
        });
    }
}

function createInput(segment: Blob): Input {
    const source = new BlobSource(segment);

    return new Input({
        formats: ALL_FORMATS,
        source,
    });
}

async function writeTracks(inputs: Input[], format: OutputFormat): Promise<ArrayBuffer | null> {
    const layoutsPromises = inputs.map(readTrackSet);
    const layouts = await Promise.all(layoutsPromises);
    const [firstLayout] = layouts;
    const descriptionsPromises = layouts.map(describeTrackSet);
    const descriptions = await Promise.all(descriptionsPromises);

    if (!firstLayout || !allEqual(descriptions) || (!firstLayout.audio && !firstLayout.video)) {
        return null;
    }

    const target = new BufferTarget();
    const output = new Output({
        format,
        target,
    });
    const writers = await addOutputTracks(output, firstLayout);

    await output.start();

    try {
        await appendSegments(layouts, writers, 0);
    } catch (error) {
        await output.cancel();

        throw error;
    }

    await output.finalize();

    return target.buffer;
}

function allEqual(values: string[]): boolean {
    const [first] = values;

    return values.every(value => value === first);
}

async function readTrackSet(input: Input): Promise<TrackSet> {
    const audioPromise = input.getPrimaryAudioTrack();
    const videoPromise = input.getPrimaryVideoTrack();
    const [audio, video] = await Promise.all([audioPromise, videoPromise]);

    return { audio, video };
}

// Segments can only be joined when they share this description.
async function describeTrackSet(tracks: TrackSet): Promise<string> {
    const audioDescription = tracks.audio ? await describeAudioTrack(tracks.audio) : 'none';
    const videoDescription = tracks.video ? await describeVideoTrack(tracks.video) : 'none';

    return [audioDescription, videoDescription].join(' ');
}

async function describeAudioTrack(track: InputAudioTrack): Promise<string> {
    const codecPromise = track.getCodec();
    const channelsPromise = track.getNumberOfChannels();
    const sampleRatePromise = track.getSampleRate();
    const [codec, channels, sampleRate] = await Promise.all([codecPromise, channelsPromise, sampleRatePromise]);

    return ['audio', codec, channels, sampleRate].join(' ');
}

async function describeVideoTrack(track: InputVideoTrack): Promise<string> {
    const codecPromise = track.getCodec();
    const widthPromise = track.getCodedWidth();
    const heightPromise = track.getCodedHeight();
    const [codec, width, height] = await Promise.all([codecPromise, widthPromise, heightPromise]);

    return ['video', codec, width, height].join(' ');
}

async function addOutputTracks(output: Output, tracks: TrackSet): Promise<WriterSet> {
    const audioWriter = tracks.audio ? await addAudioTrack(output, tracks.audio) : null;
    const videoWriter = tracks.video ? await addVideoTrack(output, tracks.video) : null;

    return { audio: audioWriter, video: videoWriter };
}

async function addAudioTrack(output: Output, track: InputAudioTrack): Promise<PacketWriter> {
    const codecPromise = track.getCodec();
    const decoderConfigPromise = track.getDecoderConfig();
    const [codec, decoderConfig] = await Promise.all([codecPromise, decoderConfigPromise]);

    if (!codec || !decoderConfig) {
        throw new Error('The audio codec of this track cannot be copied.');
    }

    const source = new EncodedAudioPacketSource(codec);

    output.addAudioTrack(source);

    return createPacketWriter((packet, metadata) => source.add(packet, metadata), { decoderConfig });
}

async function addVideoTrack(output: Output, track: InputVideoTrack): Promise<PacketWriter> {
    const codecPromise = track.getCodec();
    const decoderConfigPromise = track.getDecoderConfig();
    const [codec, decoderConfig] = await Promise.all([codecPromise, decoderConfigPromise]);

    if (!codec || !decoderConfig) {
        throw new Error('The video codec of this track cannot be copied.');
    }

    const source = new EncodedVideoPacketSource(codec);

    output.addVideoTrack(source);

    return createPacketWriter((packet, metadata) => source.add(packet, metadata), { decoderConfig });
}

// Only the first packet written to a track carries the decoder config.
function createPacketWriter<Metadata>(
    addPacket: (packet: EncodedPacket, metadata?: Metadata) => Promise<void>,
    firstMetadata: Metadata,
): PacketWriter {
    let isFirstPacket = true;

    return async (packet: EncodedPacket): Promise<void> => {
        const metadata = isFirstPacket ? firstMetadata : undefined;

        isFirstPacket = false;

        await addPacket(packet, metadata);
    };
}

// Segments run one after another. Each segment's packets are shifted so the
// segment starts where the previous one ended.
async function appendSegments(layouts: TrackSet[], writers: WriterSet, segmentStart: number): Promise<void> {
    const [layout, ...laterLayouts] = layouts;

    if (!layout) {
        return;
    }

    const segmentEnd = await appendSegment(layout, writers, segmentStart);

    return appendSegments(laterLayouts, writers, segmentEnd);
}

async function appendSegment(tracks: TrackSet, writers: WriterSet, segmentStart: number): Promise<number> {
    const copies = pairTracks(tracks, writers);
    const firstTimestampsPromises = copies.map(copy => copy.track.getFirstTimestamp());
    const firstTimestamps = await Promise.all(firstTimestampsPromises);
    const earliestTimestamp = Math.min(...firstTimestamps);
    // One offset for audio and video of this segment keeps them in sync.
    const offset = segmentStart - earliestTimestamp;
    const endsPromises = copies.map(copy => copyPackets(copy, offset));
    const ends = await Promise.all(endsPromises);

    return Math.max(segmentStart, ...ends);
}

function pairTracks(tracks: TrackSet, writers: WriterSet): TrackCopy[] {
    const audioCopies: TrackCopy[] = tracks.audio && writers.audio
        ? [{ track: tracks.audio, writePacket: writers.audio }]
        : [];
    const videoCopies: TrackCopy[] = tracks.video && writers.video
        ? [{ track: tracks.video, writePacket: writers.video }]
        : [];

    return [...audioCopies, ...videoCopies];
}

// Returns the end timestamp of the last packet, in output time.
async function copyPackets(copy: TrackCopy, offset: number): Promise<number> {
    const sink = new EncodedPacketSink(copy.track);
    let endTimestamp = 0;

    for await (const packet of sink.packets()) {
        const timestamp = packet.timestamp + offset;
        const shifted = packet.clone({ timestamp });

        await copy.writePacket(shifted);

        endTimestamp = Math.max(endTimestamp, timestamp + packet.duration);
    }

    return endTimestamp;
}
