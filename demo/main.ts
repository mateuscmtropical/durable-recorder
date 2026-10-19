import { DurableRecorder, RecordingStore, extensionForMimeType } from '../src';
import type {
    DurableRecorderOptions,
    FinishedRecording,
    RecorderProgress,
    RecorderState,
    RecordingMeta,
    RecordingSource,
} from '../src';
import { finalizeRecording, mergeSegments } from '../src/container';

interface SyntheticSource {
    stream: MediaStream;
    dispose: () => void;
}

const BYTES_PER_KILOBYTE = 1024;
const MS_PER_SECOND = 1000;
const SYNTHETIC_WIDTH = 640;
const SYNTHETIC_HEIGHT = 360;
const SYNTHETIC_FRAME_RATE = 30;
const SYNTHETIC_FRAME_INTERVAL_MS = 1000 / SYNTHETIC_FRAME_RATE;
const SYNTHETIC_CYCLE_MS = 4000;
const SYNTHETIC_BAR_WIDTH = 80;
const SYNTHETIC_BAR_HEIGHT = 40;
const SYNTHETIC_TONE_HZ = 440;
const SYNTHETIC_TONE_GAIN = 0.05;

// Looks up an element from index.html and fails early when it is missing.
function requireElement<T extends HTMLElement>(elementId: string, elementType: new () => T): T {
    const element = document.getElementById(elementId);

    if (!(element instanceof elementType)) {
        throw new Error(`Missing #${elementId} in demo/index.html`);
    }

    return element;
}

const elements = {
    startAudio: requireElement('start-audio', HTMLButtonElement),
    startVideo: requireElement('start-video', HTMLButtonElement),
    startScreen: requireElement('start-screen', HTMLButtonElement),
    startSynthetic: requireElement('start-synthetic', HTMLButtonElement),
    screenHint: requireElement('screen-hint', HTMLParagraphElement),
    maxDuration: requireElement('max-duration', HTMLInputElement),
    maxBytes: requireElement('max-bytes', HTMLInputElement),
    stop: requireElement('stop', HTMLButtonElement),
    cancel: requireElement('cancel', HTMLButtonElement),
    state: requireElement('state', HTMLElement),
    recordingId: requireElement('recording-id', HTMLElement),
    progress: requireElement('progress', HTMLElement),
    silence: requireElement('silence', HTMLElement),
    problems: requireElement('problems', HTMLUListElement),
    eventLog: requireElement('event-log', HTMLOListElement),
    resultEmpty: requireElement('result-empty', HTMLParagraphElement),
    videoPlayer: requireElement('video-player', HTMLVideoElement),
    audioPlayer: requireElement('audio-player', HTMLAudioElement),
    download: requireElement('download', HTMLAnchorElement),
    storedList: requireElement('stored-list', HTMLUListElement),
    storedEmpty: requireElement('stored-empty', HTMLParagraphElement),
};

const store = new RecordingStore();

let activeRecorder: DurableRecorder | null = null;
let syntheticSource: SyntheticSource | null = null;
let downloadUrl: string | null = null;

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return 'Unknown error';
}

// Empty or invalid input means no limit.
function readOptionalNumber(input: HTMLInputElement): number | undefined {
    const text = input.value.trim();

    if (text === '') {
        return undefined;
    }

    const parsed = Number(text);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }

    return parsed;
}

function updateControls(): void {
    const isBusy = activeRecorder !== null;

    elements.startAudio.disabled = isBusy || !DurableRecorder.isSupported('audio');
    elements.startVideo.disabled = isBusy || !DurableRecorder.isSupported('video');
    elements.startScreen.disabled = isBusy || !DurableRecorder.isSupported('screen');
    elements.startSynthetic.disabled = isBusy;
    elements.screenHint.hidden = DurableRecorder.isSupported('screen');
    elements.stop.disabled = !isBusy;
    elements.cancel.disabled = !isBusy;
    elements.maxDuration.disabled = isBusy;
    elements.maxBytes.disabled = isBusy;
}

function appendLog(message: string): void {
    const entry = document.createElement('li');
    const now = new Date();
    const timeText = now.toLocaleTimeString();

    entry.textContent = `${timeText} ${message}`;
    elements.eventLog.append(entry);
}

function showProgress(progress: RecorderProgress): void {
    const seconds = (progress.durationMs / MS_PER_SECOND).toFixed(1);
    const kilobytes = (progress.sizeBytes / BYTES_PER_KILOBYTE).toFixed(1);

    elements.progress.textContent = `${seconds} s, ${kilobytes} KB`;
}

function showSilence(secondsLeft: number): void {
    const secondsText = String(secondsLeft);
    const hasCountdown = secondsLeft > 0;

    elements.silence.textContent = hasCountdown ? `Silent, stops in ${secondsText} s` : 'No silence';
}

// The state event is the only place that clears the active recorder, so every end path goes through here.
function handleState(state: RecorderState): void {
    elements.state.textContent = state;

    if (state === 'idle') {
        activeRecorder = null;
        releaseSyntheticSource();
        showSilence(0);
        updateControls();
        void refreshStoredList();
    }
}

function resetRunView(): void {
    elements.problems.replaceChildren();
    elements.recordingId.textContent = 'none';
    showProgress({ durationMs: 0, sizeBytes: 0 });
    showSilence(0);
}

function buildOptions(source: RecordingSource): DurableRecorderOptions {
    const options: DurableRecorderOptions = {
        finalize: finalizeRecording,
        source,
        store,
    };
    const maxDurationMs = readOptionalNumber(elements.maxDuration);
    const maxBytes = readOptionalNumber(elements.maxBytes);

    if (maxDurationMs !== undefined) {
        options.maxDurationMs = maxDurationMs;
    }

    if (maxBytes !== undefined) {
        options.maxBytes = maxBytes;
    }

    return options;
}

function attachRecorderEvents(recorder: DurableRecorder): void {
    recorder.on('state', (payload) => {
        handleState(payload.state);
    });
    recorder.on('progress', (progress) => {
        showProgress(progress);
    });
    recorder.on('problem', (payload) => {
        const item = document.createElement('li');

        item.textContent = `${payload.code}: ${payload.error.message}`;
        elements.problems.append(item);
        appendLog(`Problem ${payload.code}`);
    });
    recorder.on('silence', (payload) => {
        showSilence(payload.secondsLeft);
    });
    recorder.on('limit-near', (payload) => {
        const percent = Math.round(payload.ratio * 100);
        const percentText = String(percent);

        appendLog(`${payload.kind} limit at ${percentText} percent`);
    });
    recorder.on('limit', (payload) => {
        appendLog(`${payload.kind} limit reached`);
    });
    recorder.on('storage-error', (payload) => {
        appendLog(`Storage error: ${describeError(payload.error)}`);
    });
    recorder.on('finish', (finished) => {
        showFinished(finished);
    });
}

async function startRecording(source: RecordingSource): Promise<void> {
    const options = buildOptions(source);
    const recorder = new DurableRecorder(options);

    resetRunView();
    activeRecorder = recorder;
    attachRecorderEvents(recorder);
    updateControls();

    try {
        await recorder.start();
        elements.recordingId.textContent = recorder.recordingId ?? 'none';
    } catch (error: unknown) {
        appendLog(`Could not start: ${describeError(error)}`);
    }
}

async function stopRecording(): Promise<void> {
    const recorder = activeRecorder;

    if (!recorder) {
        return;
    }

    const finished = await recorder.stop();

    if (!finished) {
        appendLog('Stopped with nothing to keep.');
    }
}

async function cancelRecording(): Promise<void> {
    const recorder = activeRecorder;

    if (!recorder) {
        return;
    }

    await recorder.cancel();
    appendLog('Cancelled and deleted the stored copy.');
}

// The oscillator and the AudioContext need a user gesture, so this runs from a click.
function createSyntheticAudio(): SyntheticSource {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();

    oscillator.frequency.value = SYNTHETIC_TONE_HZ;
    gain.gain.value = SYNTHETIC_TONE_GAIN;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    const dispose = (): void => {
        oscillator.stop();
        void audioContext.close();
    };

    return {
        stream: destination.stream,
        dispose,
    };
}

function drawFrame(context: CanvasRenderingContext2D, frameTime: number): void {
    const phase = (frameTime % SYNTHETIC_CYCLE_MS) / SYNTHETIC_CYCLE_MS;
    const barX = phase * (SYNTHETIC_WIDTH - SYNTHETIC_BAR_WIDTH);
    const barY = (SYNTHETIC_HEIGHT - SYNTHETIC_BAR_HEIGHT) / 2;

    context.fillStyle = '#1b2735';
    context.fillRect(0, 0, SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT);
    context.fillStyle = '#f5b841';
    context.fillRect(barX, barY, SYNTHETIC_BAR_WIDTH, SYNTHETIC_BAR_HEIGHT);
    context.fillStyle = '#ffffff';
    context.font = '28px sans-serif';
    context.fillText('Synthetic stream', 24, 48);
}

// The recorder does not stop tracks of a stream the app passed in, so this source stops its own.
function createSyntheticSource(): SyntheticSource {
    const canvas = document.createElement('canvas');

    canvas.width = SYNTHETIC_WIDTH;
    canvas.height = SYNTHETIC_HEIGHT;

    const context = canvas.getContext('2d');

    if (!context) {
        throw new Error('Canvas 2D is not available in this browser.');
    }

    const drawTimer = setInterval(() => {
        const frameTime = Date.now();

        drawFrame(context, frameTime);
    }, SYNTHETIC_FRAME_INTERVAL_MS);
    const videoStream = canvas.captureStream(SYNTHETIC_FRAME_RATE);
    const videoTracks = videoStream.getVideoTracks();
    const audio = createSyntheticAudio();
    const audioTracks = audio.stream.getAudioTracks();
    const stream = new MediaStream([...videoTracks, ...audioTracks]);

    const dispose = (): void => {
        clearInterval(drawTimer);
        videoTracks.forEach((track) => {
            track.stop();
        });
        audio.dispose();
    };

    return {
        stream,
        dispose,
    };
}

function releaseSyntheticSource(): void {
    const synthetic = syntheticSource;

    syntheticSource = null;

    if (synthetic) {
        synthetic.dispose();
    }
}

function startSyntheticRecording(): void {
    try {
        const synthetic = createSyntheticSource();

        syntheticSource = synthetic;
        void startRecording(synthetic.stream);
    } catch (error: unknown) {
        appendLog(`Synthetic stream unavailable: ${describeError(error)}`);
    }
}

function revokeDownloadUrl(): void {
    if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
        downloadUrl = null;
    }
}

// Shows the recording in the video or audio element that matches its type, and points the download link at it.
function showRecording(blob: Blob, mimeType: string, recordingId: string, extension: string): void {
    const url = URL.createObjectURL(blob);
    const isVideo = mimeType.startsWith('video/');
    const player = isVideo ? elements.videoPlayer : elements.audioPlayer;
    const idlePlayer = isVideo ? elements.audioPlayer : elements.videoPlayer;

    revokeDownloadUrl();
    downloadUrl = url;
    idlePlayer.removeAttribute('src');
    idlePlayer.hidden = true;
    player.src = url;
    player.hidden = false;
    elements.resultEmpty.hidden = true;
    elements.download.href = url;
    elements.download.download = `durable-recording-${recordingId}.${extension}`;
    elements.download.hidden = false;
}

function showFinished(finished: FinishedRecording): void {
    const seconds = (finished.durationMs / MS_PER_SECOND).toFixed(1);
    const kilobytes = (finished.sizeBytes / BYTES_PER_KILOBYTE).toFixed(1);

    showRecording(finished.blob, finished.mimeType, finished.id, finished.extension);
    appendLog(`Finished: ${seconds} s, ${kilobytes} KB, .${finished.extension}`);
}

function createStoredItem(meta: RecordingMeta): HTMLLIElement {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const playButton = document.createElement('button');
    const deleteButton = document.createElement('button');
    const startedDate = new Date(meta.createdAt);
    const startedAt = startedDate.toLocaleString();
    const shortId = meta.id.slice(0, 8);

    label.textContent = `${meta.source}, ${meta.mimeType}, started ${startedAt} (${shortId})`;

    playButton.type = 'button';
    playButton.textContent = 'Play';
    playButton.addEventListener('click', () => {
        void playStoredRecording(meta.id);
    });

    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
        void deleteStoredRecording(meta.id);
    });

    item.append(label, playButton, deleteButton);

    return item;
}

function renderStoredList(recordings: RecordingMeta[]): void {
    elements.storedList.replaceChildren();
    elements.storedEmpty.hidden = recordings.length > 0;

    recordings.forEach((meta) => {
        const item = createStoredItem(meta);

        elements.storedList.append(item);
    });
}

async function refreshStoredList(): Promise<void> {
    try {
        const recordings = await store.list();

        renderStoredList(recordings);
    } catch (error: unknown) {
        appendLog(`Could not list stored recordings: ${describeError(error)}`);
    }
}

// Joins the saved segments into one file, then adds the duration, as the recorder does for finished files.
async function playStoredRecording(recordingId: string): Promise<void> {
    try {
        const stored = await store.load(recordingId);

        if (!stored) {
            appendLog(`Recording ${recordingId} is gone.`);

            return;
        }

        const merged = await mergeSegments(stored.segments, stored.mimeType);

        if (!merged) {
            appendLog(`Could not join the segments of ${recordingId}.`);

            return;
        }

        const playable = await finalizeRecording(merged, stored.mimeType);
        const extension = extensionForMimeType(stored.mimeType);

        showRecording(playable, stored.mimeType, stored.id, extension);
        appendLog(`Playing stored recording ${stored.id}.`);
    } catch (error: unknown) {
        appendLog(`Could not play ${recordingId}: ${describeError(error)}`);
    }
}

async function deleteStoredRecording(recordingId: string): Promise<void> {
    try {
        await store.delete(recordingId);
        appendLog(`Deleted stored recording ${recordingId}.`);
    } catch (error: unknown) {
        appendLog(`Could not delete ${recordingId}: ${describeError(error)}`);
    }

    await refreshStoredList();
}

elements.startAudio.addEventListener('click', () => {
    void startRecording('audio');
});
elements.startVideo.addEventListener('click', () => {
    void startRecording('video');
});
elements.startScreen.addEventListener('click', () => {
    void startRecording('screen');
});
elements.startSynthetic.addEventListener('click', () => {
    startSyntheticRecording();
});
elements.stop.addEventListener('click', () => {
    void stopRecording();
});
elements.cancel.addEventListener('click', () => {
    void cancelRecording();
});

updateControls();
void refreshStoredList();
