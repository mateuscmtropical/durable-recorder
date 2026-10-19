import type { LimitKind, RecorderProgress } from './recorderTypes';

interface LimitTrackerOptions {
    maxBytes?: number | undefined;
    maxDurationMs?: number | undefined;
    warnAt: number;
}

interface LimitCheck {
    near: LimitKind[];
    reached: LimitKind[];
}

interface LimitTracker {
    check: (progress: RecorderProgress) => LimitCheck;
}

interface LimitMeasure {
    kind: LimitKind;
    value: number;
    limit: number | undefined;
}

// A missing, zero, negative, NaN or infinite limit means no limit for that kind.
function hasLimit(limit: number | undefined): limit is number {
    return limit !== undefined && Number.isFinite(limit) && limit > 0;
}

function measuresFor(options: LimitTrackerOptions, progress: RecorderProgress): LimitMeasure[] {
    return [
        { kind: 'bytes', value: progress.sizeBytes, limit: options.maxBytes },
        { kind: 'duration', value: progress.durationMs, limit: options.maxDurationMs },
    ];
}

// Near means past the warning fraction but not yet at the limit.
function isNear(measure: LimitMeasure, warnAt: number): boolean {
    if (!hasLimit(measure.limit)) {
        return false;
    }

    const ratio = measure.value / measure.limit;

    return ratio >= warnAt && ratio < 1;
}

function isReached(measure: LimitMeasure): boolean {
    return hasLimit(measure.limit) && measure.value >= measure.limit;
}

// Returns the kinds that were not reported before, and marks them as reported.
function takeUnreported(kinds: LimitKind[], reported: Set<LimitKind>): LimitKind[] {
    const fresh = kinds.filter(kind => !reported.has(kind));

    fresh.forEach((kind) => {
        reported.add(kind);
    });

    return fresh;
}

function createLimitTracker(options: LimitTrackerOptions): LimitTracker {
    const nearReported = new Set<LimitKind>();
    const reachedReported = new Set<LimitKind>();

    return {
        check: (progress) => {
            const measures = measuresFor(options, progress);
            const nearKinds = measures
                .filter(measure => isNear(measure, options.warnAt))
                .map(measure => measure.kind);
            const reachedKinds = measures
                .filter(isReached)
                .map(measure => measure.kind);
            const near = takeUnreported(nearKinds, nearReported);
            const reached = takeUnreported(reachedKinds, reachedReported);

            return { near, reached };
        },
    };
}

// Share of the limit used so far. Zero when that kind has no limit.
function limitRatio(options: LimitTrackerOptions, progress: RecorderProgress, kind: LimitKind): number {
    const measures = measuresFor(options, progress);
    const measure = measures.find(item => item.kind === kind);

    if (!measure || !hasLimit(measure.limit)) {
        return 0;
    }

    return measure.value / measure.limit;
}

// True when a limit is reached now, including one that was reported before.
function isLimitReached(options: LimitTrackerOptions, progress: RecorderProgress): boolean {
    const measures = measuresFor(options, progress);

    return measures.some(isReached);
}

export { createLimitTracker, isLimitReached, limitRatio };
export type { LimitCheck, LimitTracker, LimitTrackerOptions };
