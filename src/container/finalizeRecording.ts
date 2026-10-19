import { baseMimeType, copySegments } from './mergeSegments';

const WEBM_TYPES = ['audio/webm', 'video/webm'];

// Chrome's WebM has no duration header, so players show no total time. Copying
// the packets into a new WebM writes the duration.
async function finalizeRecording(recording: Blob, mimeType: string): Promise<Blob> {
    const type = baseMimeType(mimeType);

    if (!WEBM_TYPES.includes(type)) {
        return recording;
    }

    const remuxed = await copySegments([recording], mimeType);

    return remuxed ?? recording;
}

export { finalizeRecording };
