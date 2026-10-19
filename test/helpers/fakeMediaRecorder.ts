import { vi } from 'vitest';

type FakeRecorderState = 'inactive' | 'recording' | 'paused';

interface FakeMediaRecorderOptions {
    // The types that isTypeSupported answers yes to. Default is none.
    supportedTypes?: readonly string[];
    // The mimeType the recorder reports. Default echoes the requested type, or ''.
    reportedMimeType?: string;
    // Thrown by the constructor, like a browser that rejects the options.
    constructorError?: Error;
    // Thrown by start().
    startError?: Error;
    // Thrown by pause().
    pauseError?: Error;
}

interface FakeMediaRecorderControl {
    recorders: FakeMediaRecorder[];
}

// Events carry their payload like the browser ones do.
class FakeBlobEvent extends Event {
    readonly data: Blob;

    constructor(type: string, data: Blob) {
        super(type);
        this.data = data;
    }
}

class FakeRecorderErrorEvent extends Event {
    readonly error: Error;

    constructor(error: Error) {
        super('error');
        this.error = error;
    }
}

let activeOptions: FakeMediaRecorderOptions = {};
let createdRecorders: FakeMediaRecorder[] = [];

// A MediaRecorder you drive by hand. Slices, errors and the stop event only
// happen when a test asks for them. The stop event comes after a microtask,
// as it does in the browser.
class FakeMediaRecorder extends EventTarget {
    static isTypeSupported(mimeType: string): boolean {
        return (activeOptions.supportedTypes ?? []).includes(mimeType);
    }

    readonly stream: MediaStream;
    readonly requestedOptions: MediaRecorderOptions | undefined;
    readonly mimeType: string;
    state: FakeRecorderState = 'inactive';
    timeslice: number | undefined = undefined;
    startCount = 0;
    pauseCount = 0;
    resumeCount = 0;
    stopCount = 0;
    ondataavailable: ((event: FakeBlobEvent) => void) | null = null;
    onerror: ((event: FakeRecorderErrorEvent) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super();

        if (activeOptions.constructorError) {
            throw activeOptions.constructorError;
        }

        this.stream = stream;
        this.requestedOptions = options;
        this.mimeType = activeOptions.reportedMimeType ?? options?.mimeType ?? '';
        createdRecorders.push(this);
    }

    start(timeslice?: number): void {
        if (activeOptions.startError) {
            throw activeOptions.startError;
        }

        this.startCount += 1;
        this.timeslice = timeslice;
        this.state = 'recording';
    }

    // Like the browser, pausing an inactive recorder throws and pausing a paused one does nothing.
    pause(): void {
        if (activeOptions.pauseError) {
            throw activeOptions.pauseError;
        }

        if (this.state === 'inactive') {
            throw new DOMException('The MediaRecorder is inactive.', 'InvalidStateError');
        }

        if (this.state === 'recording') {
            this.pauseCount += 1;
            this.state = 'paused';
        }
    }

    // Like the browser, resuming an inactive recorder throws and resuming a recording one does nothing.
    resume(): void {
        if (this.state === 'inactive') {
            throw new DOMException('The MediaRecorder is inactive.', 'InvalidStateError');
        }

        if (this.state === 'paused') {
            this.resumeCount += 1;
            this.state = 'recording';
        }
    }

    // Like the browser, nothing happens when the recorder is already inactive.
    stop(): void {
        if (this.state === 'inactive') {
            return;
        }

        this.stopCount += 1;
        this.state = 'inactive';
        queueMicrotask(() => {
            const event = new Event('stop');

            this.onstop?.(event);
            this.dispatchEvent(event);
        });
    }

    // Emits a slice of the given size. Each byte has the value fill, so tests
    // can tell slices apart.
    emitSlice(size: number, fill = 0): void {
        const bytes = new Uint8Array(size)
            .fill(fill);
        const blob = new Blob([bytes], { type: this.mimeType || 'audio/webm' });

        this.emitData(blob);
    }

    emitData(blob: Blob): void {
        const event = new FakeBlobEvent('dataavailable', blob);

        this.ondataavailable?.(event);
        this.dispatchEvent(event);
    }

    emitError(error: Error): void {
        const event = new FakeRecorderErrorEvent(error);

        this.onerror?.(event);
        this.dispatchEvent(event);
    }
}

// Replaces the global MediaRecorder. Every constructed recorder is listed in
// the returned control. vi.unstubAllGlobals() removes the stub.
function installFakeMediaRecorder(options: FakeMediaRecorderOptions = {}): FakeMediaRecorderControl {
    const recorders: FakeMediaRecorder[] = [];

    activeOptions = options;
    createdRecorders = recorders;
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    return { recorders };
}

export { FakeMediaRecorder, installFakeMediaRecorder };
export type { FakeMediaRecorderControl, FakeMediaRecorderOptions };
