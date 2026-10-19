const AUDIO_MIME_TYPES: readonly string[] = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
];

const VIDEO_MIME_TYPES: readonly string[] = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
];

const EXTENSION_BY_BASE_TYPE = new Map<string, string>([
    ['audio/webm', 'webm'],
    ['video/webm', 'webm'],
    ['audio/mp4', 'm4a'],
    ['video/mp4', 'mp4'],
    ['audio/ogg', 'ogg'],
    ['audio/mpeg', 'mp3'],
]);

function isTypeSupported(mimeType: string): boolean {
    try {
        return MediaRecorder.isTypeSupported(mimeType);
    } catch {
        // Some older browsers throw instead of returning false.
        return false;
    }
}

function pickMimeType(hasVideo: boolean, preferred?: string): string | undefined {
    if (typeof MediaRecorder === 'undefined') {
        return undefined;
    }

    if (preferred !== undefined && isTypeSupported(preferred)) {
        return preferred;
    }

    const candidates = hasVideo ? VIDEO_MIME_TYPES : AUDIO_MIME_TYPES;

    return candidates.find(isTypeSupported);
}

// Drops the parameters such as codecs. Returns the trimmed, lower case base type.
function baseMimeType(mimeType: string): string {
    const withoutParameters = mimeType.replace(/;.*$/, '');
    const trimmed = withoutParameters.trim();

    return trimmed.toLowerCase();
}

function extensionForMimeType(mimeType: string): string {
    const base = baseMimeType(mimeType);

    return EXTENSION_BY_BASE_TYPE.get(base) ?? 'webm';
}

export { AUDIO_MIME_TYPES, VIDEO_MIME_TYPES, pickMimeType, baseMimeType, extensionForMimeType };
