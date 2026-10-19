import { describe, expect, it } from 'vitest';
import { createLimitTracker } from './limitTracker';

const WARN_AT = 0.9;

describe('createLimitTracker', () => {
    it('reports nothing when no limit is set', () => {
        const tracker = createLimitTracker({ warnAt: WARN_AT });

        const check = tracker.check({ durationMs: 1_000_000_000, sizeBytes: 1_000_000_000_000 });

        expect(check)
            .toEqual({ near: [], reached: [] });
    });

    it.each([0, -1, Number.NaN])('treats the byte limit %s as no limit', (maxBytes) => {
        const tracker = createLimitTracker({ maxBytes, warnAt: WARN_AT });

        const check = tracker.check({ durationMs: 0, sizeBytes: 1_000_000 });

        expect(check)
            .toEqual({ near: [], reached: [] });
    });

    it.each([0, -1, Number.NaN])('treats the duration limit %s as no limit', (maxDurationMs) => {
        const tracker = createLimitTracker({ maxDurationMs, warnAt: WARN_AT });

        const check = tracker.check({ durationMs: 1_000_000, sizeBytes: 0 });

        expect(check)
            .toEqual({ near: [], reached: [] });
    });

    it('reports bytes as near once the ratio reaches warnAt', () => {
        const tracker = createLimitTracker({ maxBytes: 1000, warnAt: WARN_AT });

        const firstCheck = tracker.check({ durationMs: 0, sizeBytes: 900 });
        const secondCheck = tracker.check({ durationMs: 0, sizeBytes: 950 });

        expect(firstCheck)
            .toEqual({ near: ['bytes'], reached: [] });
        expect(secondCheck)
            .toEqual({ near: [], reached: [] });
    });

    it('reports bytes as reached once the limit is hit', () => {
        const tracker = createLimitTracker({ maxBytes: 1000, warnAt: WARN_AT });

        const firstCheck = tracker.check({ durationMs: 0, sizeBytes: 1000 });
        const secondCheck = tracker.check({ durationMs: 0, sizeBytes: 1100 });

        expect(firstCheck)
            .toEqual({ near: [], reached: ['bytes'] });
        expect(secondCheck)
            .toEqual({ near: [], reached: [] });
    });

    it('reports reached and not near when one check jumps past the limit', () => {
        const tracker = createLimitTracker({ maxBytes: 1000, warnAt: WARN_AT });

        const check = tracker.check({ durationMs: 0, sizeBytes: 1200 });

        expect(check)
            .toEqual({ near: [], reached: ['bytes'] });
    });

    it('does not repeat the near warning after the limit is reached', () => {
        const tracker = createLimitTracker({ maxBytes: 1000, warnAt: WARN_AT });

        const nearCheck = tracker.check({ durationMs: 0, sizeBytes: 950 });
        const reachedCheck = tracker.check({ durationMs: 0, sizeBytes: 1000 });

        expect(nearCheck)
            .toEqual({ near: ['bytes'], reached: [] });
        expect(reachedCheck)
            .toEqual({ near: [], reached: ['bytes'] });
    });

    it('reports duration as near at warnAt', () => {
        const tracker = createLimitTracker({ maxDurationMs: 2000, warnAt: 0.5 });

        const check = tracker.check({ durationMs: 1000, sizeBytes: 0 });

        expect(check)
            .toEqual({ near: ['duration'], reached: [] });
    });

    it('lists bytes before duration when both kinds report in one check', () => {
        const tracker = createLimitTracker({ maxBytes: 100, maxDurationMs: 100, warnAt: 0.5 });

        const nearCheck = tracker.check({ durationMs: 60, sizeBytes: 60 });
        const reachedCheck = tracker.check({ durationMs: 100, sizeBytes: 100 });

        expect(nearCheck)
            .toEqual({ near: ['bytes', 'duration'], reached: [] });
        expect(reachedCheck)
            .toEqual({ near: [], reached: ['bytes', 'duration'] });
    });
});
