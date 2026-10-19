// Fake AudioContext for silence monitor tests. Only the members the monitor
// reads are modeled. The analyser returns the samples the test sets, so no
// real audio is involved. Pass a fake context through asAudioContext when the
// code under test needs an AudioContext.

const FAKE_FFT_SIZE = 2048;

class FakeAnalyserNode {
    readonly fftSize: number;
    readonly frequencyBinCount: number;
    readCount: number;
    private samples: number[];

    constructor() {
        this.fftSize = FAKE_FFT_SIZE;
        this.frequencyBinCount = FAKE_FFT_SIZE / 2;
        this.readCount = 0;
        this.samples = [0];
    }

    // Every sample in the buffer gets this amplitude.
    setLevel(amplitude: number): void {
        this.samples = [amplitude];
    }

    // The buffer is filled from these samples, repeated if the buffer is longer.
    setSamples(samples: number[]): void {
        this.samples = samples;
    }

    getFloatTimeDomainData(target: Float32Array): void {
        this.readCount += 1;
        target.forEach((_, index) => {
            target[index] = this.samples[index % this.samples.length] ?? 0;
        });
    }
}

class FakeMediaStreamAudioSourceNode {
    readonly stream: MediaStream;
    readonly connections: FakeAnalyserNode[];

    constructor(stream: MediaStream) {
        this.stream = stream;
        this.connections = [];
    }

    connect(destination: FakeAnalyserNode): FakeAnalyserNode {
        this.connections.push(destination);

        return destination;
    }

    disconnect(): void {
        this.connections.splice(0);
    }
}

class FakeAudioContext {
    state: AudioContextState;
    readonly analyser: FakeAnalyserNode;
    readonly sources: FakeMediaStreamAudioSourceNode[];

    constructor() {
        this.state = 'running';
        this.analyser = new FakeAnalyserNode();
        this.sources = [];
    }

    createAnalyser(): FakeAnalyserNode {
        return this.analyser;
    }

    createMediaStreamSource(stream: MediaStream): FakeMediaStreamAudioSourceNode {
        const source = new FakeMediaStreamAudioSourceNode(stream);

        this.sources.push(source);

        return source;
    }

    resume(): Promise<void> {
        this.state = 'running';

        return Promise.resolve();
    }

    close(): Promise<void> {
        this.state = 'closed';

        return Promise.resolve();
    }
}

function createFakeAudioContext(): FakeAudioContext {
    return new FakeAudioContext();
}

// The monitor takes the browser type, so the fake is cast at that boundary.
function asAudioContext(context: FakeAudioContext): AudioContext {
    return context as unknown as AudioContext;
}

export { asAudioContext, createFakeAudioContext, FakeAnalyserNode, FakeAudioContext, FakeMediaStreamAudioSourceNode };
