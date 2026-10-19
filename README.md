# durable-recorder

Browser audio, video and screen recording that survives a locked phone, a killed tab or a dropped microphone.

It is built for phones and desktops. The design writes every slice of a recording to IndexedDB as it arrives, so the part recorded so far stays on the device. The building blocks for that exist today. The recorder that connects them is not in yet.

> **Status: in development, not on npm yet.** The main `DurableRecorder` class is not merged. A high-level API is coming. This version ships the parts that API will use. You can wire them together today. See [Using the building blocks today](#using-the-building-blocks-today).

## Why

Recording in a browser fails in ways that are easy to miss. The recording looks fine until the moment it matters. durable-recorder keeps the recorded part on the device and reports each problem with a typed code. The table shows what each building block does for each case.

| What goes wrong | What durable-recorder does | Module |
|---|---|---|
| The phone locks while recording | Asks the browser to keep the screen awake where the Screen Wake Lock API exists. Slices already written stay in IndexedDB. | `createWakeLockMonitor`, `RecordingStore` |
| The tab is closed or reloaded | Writes each slice to IndexedDB as it arrives. After a reload, `list` and `load` read back what was saved. | `RecordingStore` |
| The microphone or a headset disconnects | Reports `INTERRUPTED` when an input track ends. Also reports it when a track stays muted longer than `muteGraceMs`. | `createInterruptionMonitor` |
| Slices stop arriving | Reports `NO_DATA` when no `noteData()` call happens for longer than `noDataLimitMs`. | `createInterruptionMonitor` |
| The microphone sends only silence | Counts down with `warnSilence(secondsLeft)` and reports `SILENCE` at the limit. | `createSilenceMonitor` |
| The page is hidden | The browser releases the wake lock. The monitor asks for it again when the page is visible. | `createWakeLockMonitor` |
| The device runs out of storage | A full quota error passes through unchanged. `classifyStartError` maps it to `STORAGE_FULL`. `estimateAvailableBytes` reports the free space. | `RecordingStore`, `classifyStartError` |
| Segments cannot be joined | `mergeSegments` returns `null`. | `mergeSegments` |

The library reports a problem. The app decides what to do about it.

## Features

- **Capture input.** `acquireStream` gets a microphone, a camera, the screen or a `MediaStream` from your app. `releaseStream` stops the tracks that the library opened.
- **Choose a format.** `pickMimeType` returns the first format the browser can record, from a fixed list. `extensionForMimeType` returns a file extension for it.
- **Save while recording.** `RecordingStore.appendChunk` writes each slice to IndexedDB. The data stays on the device until your app deletes it or prunes it.
- **Expiry.** `RecordingStore.pruneExpired` removes recordings older than `retentionDays`, 30 by default. Nothing calls it for you yet, so call it when your app starts.
- **Segments.** A recording can have several segments. Segment 0 is the first take. A continued recording adds the next segment.
- **Join without re-encoding.** `mergeSegments` copies the encoded packets of every segment into one file. It does not decode or encode the media. A single segment is returned as it is.
- **Playable WebM.** `finalizeRecording` copies a WebM recording into a new file, which writes its duration. If the copy fails, it returns the input. `readDuration` reads the duration of a recording. `revealMediaDuration` seeks a media element to the end, so it finds the duration of a WebM file, then rewinds it to 0.
- **Monitors.** `createInterruptionMonitor`, `createSilenceMonitor` and `createWakeLockMonitor` watch a recording while it runs.
- **Typed problems.** Ten problem codes describe what went wrong. See [Problem codes](#problem-codes).
- **Not in this version.** Size and duration limits come with the recorder class.

## Phones and desktops

The library checks for each browser API it uses. It reports what is missing instead of assuming it is there.

- Capture needs a secure context, which means an HTTPS page or `localhost`. Outside a secure context, `navigator.mediaDevices` is missing and `acquireStream` throws `UNSUPPORTED`.
- Screen capture needs `getDisplayMedia`, which desktop browsers offer and phone browsers usually do not. When the browser does not have it, `acquireStream` throws `UNSUPPORTED`. Call `isRecordingSupported('screen')` before you offer screen recording.
- A phone that locks or sends the page to the background can stop the capture. The wake lock keeps the screen on while the page is visible, and every slice written before that moment stays in IndexedDB.
- Where `navigator.wakeLock` exists, `createWakeLockMonitor` asks for a screen lock while the page is visible. Where it does not exist, the monitor does not request a lock.
- The first `saveMeta` call on each `RecordingStore` asks the browser for persistent storage. `requestPersistentStorage` does the same request and returns the answer. The browser can refuse.
- Some browsers throw from `MediaRecorder.isTypeSupported` instead of returning `false`. `pickMimeType` handles that case.
- `classifyStartError` also recognizes plain objects named `DevicesNotFoundError` and `TrackStartError`, which older Chrome versions throw.
- Slices are stored as `ArrayBuffer`, not `Blob`. Every `Blob` the library returns is built in memory, so it can be uploaded on Safari 26.5 and 26.6 without a copy (https://bugs.webkit.org/show_bug.cgi?id=319985).

A list of tested browsers is planned in `docs/BROWSER_SUPPORT.md`. The file is not in the repository yet.

## How persistence works

The library uses one IndexedDB database. It is named `durable-recorder` by default and uses version 1. It has two object stores.

| Store | Key | Value |
|---|---|---|
| `recordings` | `id` | `RecordingMeta`: `id`, `mimeType`, `source`, `createdAt`, `updatedAt`, `metadata` and `nextSegment` |
| `chunks` | auto increment | `StoredChunk`: `recordingId`, `segment`, `position` and `data` (an `ArrayBuffer`). Indexed by `recordingId`. |

- Each slice is one `chunk`. `position` orders the slices inside their segment.
- `load` sorts the slices by segment and position. It returns one `Blob` per segment. A segment smaller than `minSegmentBytes` (1024 bytes by default) is left out.
- `nextSegment` in the metadata is the segment number the next continued take uses.
- Calls to one `RecordingStore` run one after another, in the order you make them.
- If the database connection was closed, the store reopens it and retries the call once.
- A slice or a metadata save survives a reload once its call has finished.
- Data leaves the store only through `delete`, `dropSegments` or `pruneExpired`. The browser can also clear site storage under pressure. Persistent storage asks the browser not to.
- `pruneExpired` removes recordings whose `updatedAt` is older than `retentionDays`. Call `saveMeta` again to move `updatedAt` forward.

## Install

The package is not on npm yet. Build it from the repository and add the local folder to your app:

```sh
git clone https://github.com/mateuscmtropical/durable-recorder.git
cd durable-recorder
pnpm install
pnpm build
cd ../your-app
pnpm add ../durable-recorder
```

The `durable-recorder/container` entry point needs `mediabunny`. It is an optional peer dependency, so install it only if you use that entry point:

```sh
pnpm add mediabunny
```

| Import path | Exports | Needs |
|---|---|---|
| `durable-recorder` | `RecordingStore`, `acquireStream`, `releaseStream`, `isRecordingSupported`, `streamHasVideo`, `pickMimeType`, `extensionForMimeType`, `AUDIO_MIME_TYPES`, `VIDEO_MIME_TYPES`, `createInterruptionMonitor`, `createSilenceMonitor`, `createWakeLockMonitor`, `classifyStartError`, `RecorderError`, `RECORDER_PROBLEM_CODES`, `isRecorderError`, `estimateAvailableBytes`, `requestPersistentStorage`, `TypedEventEmitter`, `createRecordingId`, and their types | nothing extra |
| `durable-recorder/container` | `mergeSegments`, `finalizeRecording`, `readDuration`, `revealMediaDuration` | `mediabunny` |

## Try the demo

From the repository, run `pnpm demo` and open the local address it prints in a browser. The demo records audio, video, the screen or a synthetic stream. It shows the state, progress, problems and limit events, plays the result and lists the recordings kept in IndexedDB. Reload the page during a recording to check that the saved part is still listed.

## Using the building blocks today

There is no recorder class yet. You connect `MediaRecorder` to the parts below yourself. The examples use the exported names and signatures.

### Acquire a stream and pick a format

`acquireStream` takes a `source` of `'audio'`, `'video'` or `'screen'`, or a `MediaStream` from your app. The `audio` option is `true` by default. The `video` option is `true` for `'video'` and `'screen'`, and `false` for `'audio'`. Pass `false` to leave a track out.

`acquireStream` throws a `RecorderError` with the code `UNSUPPORTED` when the browser has no capture method for the source. It throws `NO_DEVICE` when an `'audio'` stream has no audio track or a `'video'` stream has no video track. Other errors come from the browser. Pass them to `classifyStartError`.

```ts
import {
    acquireStream,
    classifyStartError,
    isRecordingSupported,
} from 'durable-recorder';
import type { AcquiredStream } from 'durable-recorder';

async function openMicrophone(): Promise<AcquiredStream | null> {
    if (!isRecordingSupported('audio')) {
        return null;
    }

    try {
        return await acquireStream({ source: 'audio' });
    } catch (error) {
        const problemCode = classifyStartError(error);

        console.warn(problemCode);

        return null;
    }
}
```

`releaseStream` stops the tracks only when the library opened the stream. For a stream your app passed in, it does nothing.

`pickMimeType(hasVideo, preferred?)` returns `preferred` when the browser supports it. Otherwise it returns the first supported format from a fixed list, or `undefined`. `extensionForMimeType` maps that format to a file extension.

```ts
import { extensionForMimeType, pickMimeType } from 'durable-recorder';

const audioMimeType = pickMimeType(false);

if (audioMimeType !== undefined) {
    const fileExtension = extensionForMimeType(audioMimeType);

    console.log(`answer.${fileExtension}`);
}
```

### Save and read recordings

`RecordingStore` takes optional settings.

| Option | Default | Meaning |
|---|---|---|
| `databaseName` | `'durable-recorder'` | Name of the IndexedDB database |
| `retentionDays` | `30` | Age in days after which `pruneExpired` removes a recording |
| `minSegmentBytes` | `1024` | Segments smaller than this are left out by `load` |
| `indexedDB` | the global `indexedDB` | The IndexedDB factory to use |

| Method | Returns | What it does |
|---|---|---|
| `saveMeta(meta)` | `Promise<void>` | Writes or replaces the metadata of a recording |
| `appendChunk(chunk)` | `Promise<void>` | Writes one slice |
| `list()` | `Promise<RecordingMeta[]>` | Lists all recordings, sorted by `createdAt` |
| `load(recordingId)` | `Promise<StoredRecording \| null>` | Returns one recording with one `Blob` per segment in `segments` |
| `delete(recordingId)` | `Promise<void>` | Removes a recording and its slices |
| `dropSegments(recordingId, fromSegment)` | `Promise<void>` | Removes the slices from `fromSegment` onward |
| `pruneExpired(now?)` | `Promise<string[]>` | Removes expired recordings and returns their ids |
| `close()` | `void` | Closes the database connection |

`RecordingStore.isSupported(factory?)` returns `true` when IndexedDB is available.

```ts
import { RecordingStore, createRecordingId } from 'durable-recorder';
import type { RecordingMeta, StoredChunk } from 'durable-recorder';

async function saveAndReadBack(audioSlice: Blob): Promise<void> {
    const store = new RecordingStore();
    const recordingId = createRecordingId();
    const createdAt = Date.now();
    const meta: RecordingMeta = {
        id: recordingId,
        mimeType: 'audio/webm',
        source: 'audio',
        createdAt,
        updatedAt: createdAt,
        metadata: { title: 'Interview' },
        nextSegment: 1,
    };
    const sliceBuffer = await audioSlice.arrayBuffer();
    const chunk: StoredChunk = {
        recordingId,
        segment: 0,
        position: 0,
        data: sliceBuffer,
    };

    await store.saveMeta(meta);
    await store.appendChunk(chunk);

    const recordings = await store.list();
    const storedRecording = await store.load(recordingId);

    console.log(recordings.length, storedRecording?.segments.length);

    await store.delete(recordingId);
}
```

To check free space and ask for persistent storage:

```ts
import { estimateAvailableBytes, requestPersistentStorage } from 'durable-recorder';

async function checkStorage(): Promise<void> {
    const freeBytes = await estimateAvailableBytes();
    const isPersistent = await requestPersistentStorage();

    console.log(freeBytes, isPersistent);
}
```

`estimateAvailableBytes` returns `null` when the browser cannot say.

### Monitors

A monitor is created from a factory and a context. The context holds the stream and two callbacks. `createInterruptionMonitor` and `createSilenceMonitor` take optional settings. `createWakeLockMonitor` takes none.

`createInterruptionMonitor` options:

| Option | Default | Meaning |
|---|---|---|
| `checkIntervalMs` | `250` | How often the no data check runs |
| `noDataLimitMs` | `5000` | How long without `noteData()` before `NO_DATA` |
| `muteGraceMs` | `2000` | How long a muted track may stay muted before `INTERRUPTED` |

`createSilenceMonitor` options:

| Option | Default | Meaning |
|---|---|---|
| `checkIntervalMs` | `250` | How often the input level is read |
| `warningMs` | `5000` | Silence after which `warnSilence(secondsLeft)` starts, once per second |
| `limitMs` | `20000` | Silence after which `SILENCE` is reported |
| `rmsThreshold` | `0.0001` | Level below which the input counts as silent |
| `createAudioContext` | the browser `AudioContext` | Factory for the `AudioContext` used to read the level |

The silence monitor calls `warnSilence(0)` when sound comes back. Without an audio track or an `AudioContext` it does nothing.

```ts
import { createInterruptionMonitor, createSilenceMonitor, createWakeLockMonitor } from 'durable-recorder';
import type { MonitorProblemCode, RecordingMonitor } from 'durable-recorder';

function startMonitors(
    stream: MediaStream,
    onProblem: (code: MonitorProblemCode) => void,
    onSilenceWarning: (secondsLeft: number) => void,
): RecordingMonitor[] {
    const monitorFactories = [createInterruptionMonitor(), createSilenceMonitor(), createWakeLockMonitor()];
    const context = {
        stream,
        reportProblem: onProblem,
        warnSilence: onSilenceWarning,
    };
    const monitors = monitorFactories.map(createMonitor => createMonitor(context));

    return monitors;
}

function noteSlice(monitors: RecordingMonitor[]): void {
    monitors.forEach((monitor) => {
        monitor.noteData();
    });
}

function stopMonitors(monitors: RecordingMonitor[]): void {
    monitors.forEach((monitor) => {
        monitor.release();
    });
}
```

Call `noteSlice` for every slice, `pause` and `resume` on the monitors when you pause and resume, and `stopMonitors` when the recording ends. `reportProblem` can be called more than once. Act on the first call only.

### Join segments and finish the file

`mergeSegments` returns `null` when it cannot join the segments. Treat that case as `NOT_JOINED` if your app reports problems. `finalizeRecording` returns the recording unchanged unless it is WebM.

```ts
import { finalizeRecording, mergeSegments, readDuration } from 'durable-recorder/container';

async function buildPlayableFile(segments: Blob[], mimeType: string): Promise<Blob | null> {
    const joined = await mergeSegments(segments, mimeType);

    if (joined === null) {
        return null;
    }

    return finalizeRecording(joined, mimeType);
}

async function describeFile(segments: Blob[], mimeType: string): Promise<number | null> {
    const playable = await buildPlayableFile(segments, mimeType);

    if (playable === null) {
        return null;
    }

    return readDuration(playable);
}
```

The `segments` value comes from `RecordingStore.load`. Pass `stored.segments` and `stored.mimeType`.

To play a WebM file that has no duration header, pass the media element to `revealMediaDuration`. The returned function stops the reveal early.

```ts
import { revealMediaDuration } from 'durable-recorder/container';

const playable = new Blob(['...'], { type: 'audio/webm' });
const objectUrl = URL.createObjectURL(playable);
const audioElement = new Audio(objectUrl);
const stopReveal = revealMediaDuration(audioElement);

stopReveal();
```

### Put it together

This example writes one audio recording. It opens the microphone, saves each slice, and returns a function that stops the recording. The monitors from the previous section can run on the same `acquired.stream`.

```ts
import {
    RecordingStore,
    acquireStream,
    createRecordingId,
    pickMimeType,
    releaseStream,
} from 'durable-recorder';

const SLICE_MILLISECONDS = 500;

async function recordAudio(): Promise<() => void> {
    const mimeType = pickMimeType(false);

    if (mimeType === undefined) {
        throw new Error('This browser cannot record audio.');
    }

    const acquired = await acquireStream({ source: 'audio' });
    const store = new RecordingStore();
    const recordingId = createRecordingId();
    const createdAt = Date.now();
    const recorder = new MediaRecorder(acquired.stream, { mimeType });
    let position = 0;

    await store.saveMeta({
        id: recordingId,
        mimeType,
        source: acquired.kind,
        createdAt,
        updatedAt: createdAt,
        metadata: {},
        nextSegment: 1,
    });

    recorder.ondataavailable = async (event) => {
        const slicePosition = position;

        position += 1;

        const sliceBuffer = await event.data.arrayBuffer();

        await store.appendChunk({
            recordingId,
            segment: 0,
            position: slicePosition,
            data: sliceBuffer,
        });
    };
    recorder.onstop = () => {
        releaseStream(acquired);
    };

    recorder.start(SLICE_MILLISECONDS);

    return () => {
        recorder.stop();
    };
}
```

This example has no error handling for the store or the monitors. Add it before you use the code in an app.

## Problem codes

`RecorderError` carries a `code` from this list, a message and an optional `cause`. Use `isRecorderError(error)` to check for it. `RECORDER_PROBLEM_CODES` lists the codes in this order.

| Code | Message | Where it comes from today |
|---|---|---|
| `DENIED` | Permission to use the device was denied. | `classifyStartError` |
| `NO_DEVICE` | No microphone or camera is available. | `acquireStream`, `classifyStartError` |
| `DEVICE_BUSY` | The device is in use by another app. | `classifyStartError` |
| `UNSUPPORTED` | This browser cannot record from the requested source. | `acquireStream`, `classifyStartError`, `RecordingStore` when IndexedDB is missing or cannot be opened |
| `NO_DATA` | No recorded data arrived for too long. | `createInterruptionMonitor` |
| `SILENCE` | The input stayed silent for too long. | `createSilenceMonitor` |
| `INTERRUPTED` | The recording was interrupted. | `createInterruptionMonitor`, `classifyStartError` |
| `EMPTY` | The recording ended without enough data to play. | Not emitted yet |
| `NOT_JOINED` | The recording segments could not be joined into one file. | Not emitted yet. `mergeSegments` returns `null`. |
| `STORAGE_FULL` | The device has no room left to store the recording. | `classifyStartError` |

`classifyStartError` maps any error to one of these codes. Errors it does not know become `INTERRUPTED`.

## Links

- [Contributing](CONTRIBUTING.md). Setup, commands and the pull request process.
- [Code of Conduct](CODE_OF_CONDUCT.md).
- [Security policy](SECURITY.md). Report security problems here, not in public issues.
- [Support](SUPPORT.md). Where to ask questions and report bugs.
- [Architecture](docs/ARCHITECTURE.md) and [coding standards](docs/CODING_STANDARDS.md).
- [Changelog](CHANGELOG.md).
- [MIT license](LICENSE).
