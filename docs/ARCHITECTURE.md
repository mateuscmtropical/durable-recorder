# Architecture

durable-recorder records audio, video or the screen in the browser and keeps
every recorded slice on the device as it arrives. If the tab dies, the phone
locks or the microphone drops, the part recorded so far is still there and can
be recovered, played, sent or continued.

This document explains how the code is organized and why. Read it before
opening a pull request that adds a module.

## Design goals

1. **Never lose recorded data.** Every slice from `MediaRecorder` is written to
   IndexedDB before anything else happens with it.
2. **Say what went wrong.** An empty result, a dropped track or a denied
   permission is reported as a typed problem, never as a silent empty file.
3. **Framework agnostic core.** The core is plain TypeScript. Framework
   bindings (React first) are thin layers in their own entry points.
4. **Pay only for what you use.** Container work (joining segments, reading
   durations) lives in a separate entry point with an optional peer
   dependency, so apps that do not need it never download it.
5. **Small, readable modules.** One responsibility per file. Pure logic is kept
   apart from browser APIs so it can be unit tested.

## Entry points

| Import path | Contents | Extra dependency |
|---|---|---|
| `durable-recorder` | `DurableRecorder`, the recording store, errors and types | none |
| `durable-recorder/container` | `mergeSegments`, `readDuration`, `revealMediaDuration` | `mediabunny` (optional peer) |
| `durable-recorder/react` | `useDurableRecorder` | `react` (optional peer) |

## Folder layout

```text
src/
  index.ts                    public exports of the core entry
  recorder/                   the DurableRecorder class and its pure helpers
    DurableRecorder.ts
    recorderOptions.ts        defaults and option normalization
    recorderEvents.ts         event map and payload types
    limitTracker.ts           byte and duration limits
    createMonitors.ts         builds the monitors enabled by the options
  sources/                    getting a MediaStream and choosing a MIME type
    acquireStream.ts
    pickMimeType.ts
  storage/                    everything that touches IndexedDB
    RecordingStore.ts
    storageQuota.ts
    storageTypes.ts
  monitors/                   watchers that run while a recording is active
    RecordingMonitor.ts       the shared interface
    interruptionMonitor.ts
    silenceMonitor.ts
    wakeLockMonitor.ts
  errors/
    RecorderError.ts
    classifyStartError.ts
  shared/                     small helpers used by several folders
    TypedEventEmitter.ts
    createRecordingId.ts
  container/                  entry point: durable-recorder/container
    index.ts
    mergeSegments.ts
    readDuration.ts
    revealMediaDuration.ts
  react/                      entry point: durable-recorder/react
    index.ts
    useDurableRecorder.ts
test/
  fixtures/                   real recordings (WebM/Opus, fragmented MP4/AAC)
  helpers/                    fake MediaRecorder, fake MediaStream and friends
docs/
  ARCHITECTURE.md             this file
  CODING_STANDARDS.md         code style rules
  BROWSER_SUPPORT.md          tested browsers and known WebKit bugs
```

Tests live next to the code they cover (`limitTracker.test.ts` beside
`limitTracker.ts`). Shared fakes and binary fixtures live in `test/`.

### Dependency rules

Arrows point from the importer to the imported folder.

```text
react ──► recorder ──► sources
             │  ├────► storage
             │  ├────► monitors
             │  └────► errors
             └───────► shared ◄── (every folder may import shared)
container ──► (nothing inside src except shared)
```

- `shared` and `errors` import nothing from other folders.
- `storage`, `sources` and `monitors` never import `recorder`.
- `recorder` never imports `container` or `react`. Joining segments is
  injected through the `mergeSegments` option, which keeps `mediabunny` out of
  the core bundle.

## Recording lifecycle

```text
idle ──start()──► starting ──stream ready──► recording ◄──resume()── paused
  ▲                  │                          │  └──pause()──────────►│
  │               failure                    finish() / limit / problem │
  │                  ▼                          ▼                       │
  └──────────────── idle ◄──── finalized ◄── stopping ◄─────finish()────┘
```

1. `start()` asks `sources` for a `MediaStream` and a MIME type.
2. A `MediaRecorder` starts with a `timeslice` (500 ms by default).
3. Each `dataavailable` slice is handed to `RecordingStore.appendChunk` through
   a serial queue, so writes, metadata updates and deletes never run out of
   order. Slices are stored as `ArrayBuffer`, not `Blob`, so `load` returns
   in-memory Blobs. Safari 26.5 and 26.6 can upload disk-backed Files with an
   empty body (WebKit bug 319985: https://bugs.webkit.org/show_bug.cgi?id=319985).
4. `limitTracker` adds the slice size and elapsed time and decides whether a
   limit is near or reached.
5. Monitors watch the stream (track ended, muted, no data, silence) and keep
   the screen awake. They report problems back to the recorder.
6. `finish()` stops the recorder, builds the final `Blob` and returns it. The
   stored copy stays on the device until the app calls `forget(id)`, which it
   should do after the upload is confirmed.

## Storage model

One IndexedDB database (`durable-recorder` by default) with two object stores.

| Store | Key | Value |
|---|---|---|
| `recordings` | `id` | `{ id, mimeType, createdAt, updatedAt, source, metadata, nextSegment }` |
| `chunks` | auto increment | `{ recordingId, segment, position, data: ArrayBuffer }` with an index on `recordingId` |

A recording can have several **segments**. Segment 0 is the first take.
Continuing an interrupted recording appends segment 1, 2 and so on. Segments
are joined with `durable-recorder/container` when the app asks for one file.

Recordings expire after `retentionDays` (30 by default) and are removed by
`RecordingStore.pruneExpired()`.

## Monitors

A monitor is a small object created when recording starts and released when it
stops.

```ts
interface RecordingMonitor {
    noteData(): void;   // a slice arrived
    pause(): void;
    resume(): void;
    release(): void;    // remove listeners, timers and locks
}
```

Monitors receive a context with the stream and two callbacks:
`reportProblem(code)` and `emit(event, payload)`. They never call
`MediaRecorder` directly. `createMonitors.ts` decides which monitors run from
the options, so adding a monitor touches one line there.

## Errors and problems

Failures that stop a recording are surfaced as a `RecorderProblemCode`:

| Code | Meaning |
|---|---|
| `DENIED` | The user or the browser refused the permission |
| `NO_DEVICE` | No microphone or camera is available |
| `DEVICE_BUSY` | The device is in use (for example during a phone call) |
| `UNSUPPORTED` | The browser lacks `MediaRecorder`, the requested source or IndexedDB |
| `NO_DATA` | No slice arrived for too long |
| `SILENCE` | The input stayed silent for too long |
| `INTERRUPTED` | The track ended, stayed muted or the recorder failed |
| `EMPTY` | Recording finished without enough data to be playable |
| `NOT_JOINED` | Segments could not be joined into one file |
| `STORAGE_FULL` | The device has no room left for new slices |

`RecorderError` carries the code and the original error as `cause`.

## Testing strategy

- **Unit tests** with Vitest and happy-dom for pure logic (limits, option
  normalization, MIME selection, error classification).
- **Storage tests** with `fake-indexeddb`.
- **Recorder tests** with the fakes in `test/helpers` that emulate
  `MediaRecorder` and `MediaStream` events.
- **Container tests** with real recordings in `test/fixtures`, so joining is
  checked against the formats browsers actually produce.
- **Manual device tests** on real iOS Safari and Android Chrome before every
  release, recorded in `docs/BROWSER_SUPPORT.md`.
