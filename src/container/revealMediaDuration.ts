const SEEK_PAST_END = Number.MAX_SAFE_INTEGER;

const REVEAL_EVENTS = ['durationchange', 'timeupdate'];

// Only one pending reveal per element. A new call stops the previous one.
const stopPendingReveals = new WeakMap<HTMLMediaElement, () => void>();

// WebM from MediaRecorder has no duration header, so the element reports NaN
// until it scans the file. Seeking far past the end makes it scan, then the
// position goes back to 0.
function revealMediaDuration(media: HTMLMediaElement): () => void {
    stopPendingReveals.get(media)?.();

    if (Number.isFinite(media.duration)) {
        return () => undefined;
    }

    const stopReveal = (): void => {
        REVEAL_EVENTS.forEach((eventName) => {
            media.removeEventListener(eventName, rewindWhenKnown);
        });

        if (stopPendingReveals.get(media) === stopReveal) {
            stopPendingReveals.delete(media);
        }
    };

    const rewindWhenKnown = (): void => {
        if (!Number.isFinite(media.duration) || media.seeking) {
            return;
        }

        stopReveal();
        media.currentTime = 0;
    };

    REVEAL_EVENTS.forEach((eventName) => {
        media.addEventListener(eventName, rewindWhenKnown);
    });
    stopPendingReveals.set(media, stopReveal);
    media.currentTime = SEEK_PAST_END;

    return stopReveal;
}

export { revealMediaDuration };
