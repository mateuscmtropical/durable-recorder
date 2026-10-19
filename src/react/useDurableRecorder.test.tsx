import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingStore } from '../storage/RecordingStore';
import { createInterruptionMonitor } from '../monitors';
import { FakeMediaStreamTrack, createFakeStream, stubMediaDevices } from '../../test/helpers/fakeMedia';
import type { MediaDevicesStub } from '../../test/helpers/fakeMedia';
import { installFakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import type { FakeMediaRecorder } from '../../test/helpers/fakeMediaRecorder';
import type { DurableRecorderOptions } from '../recorder';
import { useDurableRecorder } from './useDurableRecorder';

const AUDIO_TYPE = 'audio/webm;codecs=opus';
const EVENT_NAMES = ['state', 'progress', 'problem', 'finish'] as const;
const ACTION_NAMES = ['start', 'stop', 'cancel', 'pause', 'resume', 'listRecoverable', 'continueRecording'] as const;

interface Harness {
    track: FakeMediaStreamTrack;
    recorders: FakeMediaRecorder[];
    devices: MediaDevicesStub;
}

let factory: IDBFactory;

function lastOf<Item>(items: Item[]): Item {
    const last = items.at(-1);

    if (last === undefined) {
        throw new Error('Expected at least one item');
    }

    return last;
}

// No store unless a test passes one, so most tests need no IndexedDB.
function createOptions(overrides: DurableRecorderOptions = {}): DurableRecorderOptions {
    return { store: null, minRecordingBytes: 1, monitors: [], ...overrides };
}

// One microphone and a fake MediaRecorder that the test drives by hand.
function setupDevices(): Harness {
    const browser = installFakeMediaRecorder({ supportedTypes: [AUDIO_TYPE] });
    const track = new FakeMediaStreamTrack('audio');
    const devices = stubMediaDevices({ getUserMedia: { resolve: createFakeStream([track]) } });

    return { track, recorders: browser.recorders, devices };
}

describe('useDurableRecorder', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        factory = new IDBFactory();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('starts idle with empty progress, no problems and no finished recording', () => {
        setupDevices();

        const { result } = renderHook(() => useDurableRecorder(createOptions()));

        expect(result.current.state)
            .toBe('idle');
        expect(result.current.progress)
            .toEqual({ durationMs: 0, sizeBytes: 0 });
        expect(result.current.problems)
            .toEqual([]);
        expect(result.current.finished)
            .toBeNull();
    });

    it('shows the state as the recording starts, pauses, resumes and stops', async () => {
        const { recorders } = setupDevices();
        const { result } = renderHook(() => useDurableRecorder(createOptions()));

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.state)
            .toBe('recording');

        act(() => {
            result.current.pause();
        });

        expect(result.current.state)
            .toBe('paused');

        act(() => {
            result.current.resume();
        });

        expect(result.current.state)
            .toBe('recording');

        act(() => {
            lastOf(recorders)
                .emitSlice(10);
        });
        await act(async () => {
            await result.current.stop();
        });

        expect(result.current.state)
            .toBe('idle');
    });

    it('reports progress and the new size after each slice', async () => {
        const { recorders } = setupDevices();
        const { result } = renderHook(() => useDurableRecorder(createOptions()));

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });

        expect(result.current.progress.durationMs)
            .toBe(1000);

        act(() => {
            lastOf(recorders)
                .emitSlice(10);
        });

        expect(result.current.progress)
            .toEqual({ durationMs: 1000, sizeBytes: 10 });
    });

    it('reports a problem to the component and stops the recording', async () => {
        const { track } = setupDevices();
        const options = createOptions({ monitors: [createInterruptionMonitor()] });
        const { result } = renderHook(() => useDurableRecorder(options));

        await act(async () => {
            await result.current.start();
        });
        await act(async () => {
            track.readyState = 'ended';
            track.dispatchEvent(new Event('ended'));
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(result.current.problems)
            .toEqual([expect.objectContaining({ code: 'INTERRUPTED' })]);
        expect(result.current.state)
            .toBe('idle');
    });

    it('reports the finished recording after stop, and clears it on the next start', async () => {
        const { recorders } = setupDevices();
        const { result } = renderHook(() => useDurableRecorder(createOptions()));

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            lastOf(recorders)
                .emitSlice(10);
        });
        await act(async () => {
            await result.current.stop();
        });

        expect(result.current.finished)
            .toMatchObject({ sizeBytes: 10, segments: 1 });

        await act(async () => {
            await result.current.start();
        });

        expect(result.current.finished)
            .toBeNull();
    });

    it('cancel drops the recording without a finished result', async () => {
        const { recorders, track } = setupDevices();
        const { result } = renderHook(() => useDurableRecorder(createOptions()));

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            lastOf(recorders)
                .emitSlice(10);
        });
        await act(async () => {
            await result.current.cancel();
        });

        expect(result.current.state)
            .toBe('idle');
        expect(result.current.finished)
            .toBeNull();
        expect(lastOf(recorders).stopCount)
            .toBe(1);
        expect(track.stopCount)
            .toBeGreaterThan(0);
    });

    it('holds the progress while paused and continues it after resume', async () => {
        setupDevices();
        const { result } = renderHook(() => useDurableRecorder(createOptions()));

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        act(() => {
            result.current.pause();
        });
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        expect(result.current.progress.durationMs)
            .toBe(1000);

        act(() => {
            result.current.resume();
        });
        act(() => {
            vi.advanceTimersByTime(500);
        });

        expect(result.current.progress.durationMs)
            .toBe(1500);
    });

    it('unmount removes the listeners and stops a running recording', async () => {
        const { recorders, track } = setupDevices();
        const { result, unmount } = renderHook(() => useDurableRecorder(createOptions()));
        const { recorder } = result.current;

        await act(async () => {
            await result.current.start();
        });

        EVENT_NAMES.forEach((eventName) => {
            expect(recorder.listenerCount(eventName))
                .toBe(1);
        });

        const stopSpy = vi.spyOn(recorder, 'stop');

        act(() => {
            unmount();
        });
        await stopSpy.mock.results[0]?.value;

        EVENT_NAMES.forEach((eventName) => {
            expect(recorder.listenerCount(eventName))
                .toBe(0);
        });
        expect(recorder.state)
            .toBe('idle');
        expect(lastOf(recorders).stopCount)
            .toBe(1);
        expect(track.stopCount)
            .toBeGreaterThan(0);
    });

    it('unmount mid-recording keeps the stored recording for listRecoverable', async () => {
        const store = new RecordingStore({ indexedDB: factory, minSegmentBytes: 1 });
        const { recorders, track } = setupDevices();
        const { result, unmount } = renderHook(() => useDurableRecorder(createOptions({ store })));
        const stopSpy = vi.spyOn(result.current.recorder, 'stop');

        await act(async () => {
            await result.current.start();
        });
        act(() => {
            vi.advanceTimersByTime(1000);
            lastOf(recorders)
                .emitSlice(10);
        });
        act(() => {
            unmount();
        });
        await stopSpy.mock.results[0]?.value;

        expect(lastOf(recorders).stopCount)
            .toBe(1);
        expect(track.stopCount)
            .toBeGreaterThan(0);
        expect(await result.current.listRecoverable())
            .toMatchObject([{ durationMs: 1000 }]);
    });

    it('unmount during start still stops the recording it starts and releases the stream', async () => {
        const track = new FakeMediaStreamTrack('audio');
        const browser = installFakeMediaRecorder({ supportedTypes: [AUDIO_TYPE] });
        let resolveStream: (stream: MediaStream) => void = () => undefined;
        const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
            resolveStream = resolve;
        }));

        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

        const { result, unmount } = renderHook(() => useDurableRecorder(createOptions()));
        const stopSpy = vi.spyOn(result.current.recorder, 'stop');
        let started: Promise<unknown> = Promise.resolve();

        act(() => {
            started = result.current.start()
                .catch((error: unknown) => error);
        });
        await act(async () => {
            unmount();
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(getUserMedia)
            .toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveStream(createFakeStream([track]));
            await vi.advanceTimersByTimeAsync(0);
        });
        await stopSpy.mock.results[0]?.value;

        expect(await started)
            .toBeUndefined();
        expect(browser.recorders)
            .toHaveLength(1);
        expect(lastOf(browser.recorders).stopCount)
            .toBe(1);
        expect(track.stopCount)
            .toBeGreaterThan(0);
    });

    it('mounts once under StrictMode, starts nothing, and stops the recording on unmount', async () => {
        const { recorders, devices, track } = setupDevices();
        const { result, unmount } = renderHook(() => useDurableRecorder(createOptions()), { wrapper: StrictMode });
        const { recorder } = result.current;

        expect(recorder.listenerCount('state'))
            .toBe(1);
        expect(devices.getUserMedia)
            .not.toHaveBeenCalled();
        expect(recorders)
            .toEqual([]);

        await act(async () => {
            await result.current.start();
        });

        expect(devices.getUserMedia)
            .toHaveBeenCalledTimes(1);
        expect(recorders)
            .toHaveLength(1);

        const stopSpy = vi.spyOn(recorder, 'stop');

        act(() => {
            unmount();
        });
        await stopSpy.mock.results[0]?.value;

        expect(lastOf(recorders).stopCount)
            .toBe(1);
        expect(track.stopCount)
            .toBeGreaterThan(0);
    });

    it('keeps the same actions and recorder across renders', async () => {
        setupDevices();
        const { result, rerender } = renderHook(() => useDurableRecorder(createOptions()));
        const before = result.current;

        await act(async () => {
            await result.current.start();
        });
        rerender();

        ACTION_NAMES.forEach((actionName) => {
            expect(result.current[actionName])
                .toBe(before[actionName]);
        });
        expect(result.current.recorder)
            .toBe(before.recorder);
    });
});
