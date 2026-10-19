import {
    ALL_FORMATS,
    BlobSource,
    Input,
} from 'mediabunny';

export async function readDuration(recording: Blob): Promise<number | null> {
    const source = new BlobSource(recording);
    const input = new Input({
        formats: ALL_FORMATS,
        source,
    });

    try {
        const durationSeconds = await input.computeDuration();

        return Number.isFinite(durationSeconds) ? durationSeconds : null;
    } catch {
        return null;
    } finally {
        input.dispose();
    }
}
