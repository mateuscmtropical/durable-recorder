import { describe, expect, it } from 'vitest';
import { revealMediaDuration } from './revealMediaDuration';

type Listener = (event: Event) => void;

// Any position far beyond a short recording counts as "past the end".
const FAR_PAST_END_SECONDS = 3600;
const KNOWN_DURATION_SECONDS = 1.379;

// Stands in for HTMLMediaElement. The test fires events by hand and plays the
// browser's part of setting duration after a seek.
class FakeMediaElement {
    duration = Number.POSITIVE_INFINITY;
    currentTime = 0;
    seeking = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    addEventListener(eventName: string, listener: Listener): void {
        const listenersForEvent = this.listeners.get(eventName) ?? new Set<Listener>();

        listenersForEvent.add(listener);
        this.listeners.set(eventName, listenersForEvent);
    }

    removeEventListener(eventName: string, listener: Listener): void {
        this.listeners.get(eventName)
            ?.delete(listener);
    }

    dispatch(eventName: string): void {
        const listenersForEvent = Array.from(this.listeners.get(eventName) ?? []);

        listenersForEvent.forEach((listener) => {
            listener(new Event(eventName));
        });
    }

    countListeners(): number {
        const allListeners = Array.from(this.listeners.values());

        return allListeners.reduce((total, listenersForEvent) => total + listenersForEvent.size, 0);
    }
}

function asMediaElement(media: FakeMediaElement): HTMLMediaElement {
    return media as unknown as HTMLMediaElement;
}

describe('revealMediaDuration', () => {
    it('does nothing when the duration is already known', () => {
        const media = new FakeMediaElement();

        media.duration = KNOWN_DURATION_SECONDS;
        media.currentTime = 4;

        const cleanup = revealMediaDuration(asMediaElement(media));

        media.dispatch('durationchange');

        expect(media.currentTime)
            .toBe(4);
        expect(media.countListeners())
            .toBe(0);
        expect(() => {
            cleanup();
        }).not.toThrow();
    });

    it('seeks far past the end when the duration is unknown', () => {
        const media = new FakeMediaElement();

        revealMediaDuration(asMediaElement(media));

        expect(media.currentTime)
            .toBeGreaterThan(FAR_PAST_END_SECONDS);
    });

    it.each(['durationchange', 'timeupdate'])('waits for a finite duration, then seeks back to 0 on %s', (eventName) => {
        const media = new FakeMediaElement();

        revealMediaDuration(asMediaElement(media));
        const seekedTo = media.currentTime;

        media.dispatch(eventName);

        expect(media.currentTime)
            .toBe(seekedTo);

        media.duration = KNOWN_DURATION_SECONDS;
        media.dispatch(eventName);

        expect(media.currentTime)
            .toBe(0);
    });

    it('does not seek again once it has rewound', () => {
        const media = new FakeMediaElement();

        revealMediaDuration(asMediaElement(media));
        media.duration = KNOWN_DURATION_SECONDS;
        media.dispatch('durationchange');
        media.currentTime = 2.5;
        media.dispatch('timeupdate');

        expect(media.currentTime)
            .toBe(2.5);
    });

    it('removes its listeners when the cleanup function runs', () => {
        const media = new FakeMediaElement();

        const cleanup = revealMediaDuration(asMediaElement(media));
        const seekedTo = media.currentTime;

        cleanup();
        media.duration = KNOWN_DURATION_SECONDS;
        media.dispatch('durationchange');

        expect(media.countListeners())
            .toBe(0);
        expect(media.currentTime)
            .toBe(seekedTo);
    });

    it('cancels the previous pending call when called again on the same element', () => {
        const media = new FakeMediaElement();

        revealMediaDuration(asMediaElement(media));
        const listenersAfterFirstCall = media.countListeners();

        revealMediaDuration(asMediaElement(media));

        expect(media.countListeners())
            .toBe(listenersAfterFirstCall);
    });
});
