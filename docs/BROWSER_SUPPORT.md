# Browser support

This page lists the browsers the project has tested and the known WebKit bugs
that affect it. Results are added after each release check.

## Tested browsers

| Browser | Platform | Status | Notes |
|---|---|---|---|
| Opera 137 (Chromium 153) | Windows 11 | Tested with the demo | Synthetic stream (canvas video plus an oscillator) recorded as `video/webm;codecs=vp9,opus`. Limits, reload recovery and a continued take played back. Microphone, camera and screen not tested yet. |
| Safari | iPhone (iOS) | Not tested on a device yet | |
| Chrome | Android | Not tested on a device yet | |
| Firefox | Desktop | Not tested yet | |
| Safari | macOS | Not tested yet | |

No phone has been tested yet. iOS Safari and Android Chrome have not been
run on a device. Their rows stay open until a device check is recorded here.

To add a result, follow the release checks in [CONTRIBUTING.md](../CONTRIBUTING.md).
Write the browser, its version, the operating system, the device and the source
(audio, video or screen) in the table row.

## Known WebKit bug 319985

Bug report: https://bugs.webkit.org/show_bug.cgi?id=319985

Safari 26.5 and 26.6 can upload a disk-backed `File` with an empty body. The
reported problem is with files on disk.

The store is not affected, by design:

- The store keeps each slice as an `ArrayBuffer` in IndexedDB. It does not keep a `File`.
- `load` builds each segment as a `Blob` in memory from those buffers.
- The library never returns a `File` object.

We have not run an upload test on Safari 26.5 or 26.6. This is the design
reason, not a device result. If your app uploads a `File` from disk, test that
upload on Safari 26.5 and 26.6 before you ship.
