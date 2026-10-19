# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package scaffold with the TypeScript build (tsup), ESLint, Vitest and the `durable-recorder` entry point. The architecture and coding standards are in `docs/`.
- GitHub Actions workflow that runs lint, typecheck, tests and build on every pull request.
- `TypedEventEmitter`, an event emitter whose event names and payloads are typed.
- `createRecordingId`, which returns a random version 4 UUID.
- `RecorderError` with a typed `code`, the `RECORDER_PROBLEM_CODES` list, `isRecorderError` and `classifyStartError`.
- `durable-recorder/container` entry point with `mergeSegments`, `readDuration`, `finalizeRecording` and `revealMediaDuration`. It uses `mediabunny`, an optional peer dependency.
- `RecordingStore`, which keeps recordings and their slices in IndexedDB, and the `estimateAvailableBytes` and `requestPersistentStorage` storage helpers.
- Contributing guide, code of conduct, security and support policies, issue forms and a pull request template.
- `createInterruptionMonitor`, which reports `NO_DATA` when slices stop arriving and `INTERRUPTED` when an input track ends or stays muted.
- `acquireStream` and `releaseStream` for microphone, camera, screen or an app provided `MediaStream`, plus `isRecordingSupported`, `pickMimeType` and `extensionForMimeType`.
- `createWakeLockMonitor`, which keeps the screen awake during a recording where the Screen Wake Lock API exists, so a phone does not lock and stop the capture.
- `createSilenceMonitor`, which warns with a countdown when the microphone input stays silent and reports `SILENCE` at the limit (20 seconds by default).
- `DurableRecorder`, which records a source, writes every slice to `RecordingStore` while recording, runs the monitors, applies size and duration limits and resolves `stop()` with the finished recording.
