# Contributing to durable-recorder

Thank you for helping. This guide covers setup, the checks every change must
pass and how to send a pull request.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Read two documents first:

- [Architecture](docs/ARCHITECTURE.md) explains the folder layout and the
  dependency rules between folders.
- [Coding standards](docs/CODING_STANDARDS.md) explains the style rules. Lint
  enforces most of them, and the rest are checked in review.

## Issues first

Every change starts with an issue, even a small one:

1. Open an issue that says what is wrong or what is missing. For a large
   change, wait until we agree on the approach.
2. Open a pull request with `Closes #N` in its description, where `N` is the
   issue number.
3. Comment on the issue with the pull request link.

A pull request without a linked issue fails the `Linked issue` check and
cannot be merged. Dependabot pull requests are the only exception.

## Setup

You need Node 20 or newer and pnpm 10.

```sh
pnpm install
```

Then run `pnpm demo` and open the local address it prints. The demo runs the
recorder in a browser, so you can see the library work before you change it.

## Commands

| Command | What it does |
|---|---|
| `pnpm lint` | Checks the code with ESLint |
| `pnpm lint:fix` | Fixes the problems ESLint can fix |
| `pnpm typecheck` | Runs the TypeScript compiler without writing output |
| `pnpm test` | Runs the test suite once |
| `pnpm build` | Builds the package into `dist` |
| `pnpm check` | Runs lint, typecheck, tests and build |

Run `pnpm lint:fix` before you commit. Run `pnpm check` before you open a pull
request. It must pass.

## Branches

Create a branch for each change. Start the name with the kind of change:

- `feat/...` for a new feature, for example `feat/silence-monitor`.
- `fix/...` for a bug fix, for example `fix/stop-after-lock`.
- `docs/...` for documentation only, for example `docs/contributing`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/). Write the
type first, then a short description:

```text
feat(monitors): detect interrupted recordings
fix(storage): keep slices written before a tab reload
```

Common types are `feat`, `fix`, `docs`, `chore`, `test`, `ci` and `refactor`.

## One change per pull request

Keep each pull request to one logical change. A bug fix and a refactor belong
in two pull requests. Small pull requests are reviewed faster.

## Tests

Changes need tests. Every module with logic ships with tests next to it, in a
file named `name.test.ts`. Test names describe the behavior, for example
`it('stops when the byte limit is reached')`.

## Testing on real devices

The library targets phones and desktops alike. Unit tests cannot show what a
phone does when it locks, or what a desktop browser does when a tab is closed
or a microphone drops. For changes that touch recording, test on a real device:

1. Serve a small page that uses your build of the library over HTTPS, from an
   address the device can reach (`localhost` also works on the same computer).
   Browsers only allow microphone, camera and screen access on secure pages.
2. Record for a few minutes.
3. Lock the phone during the recording. Unlock it and check that the recording
   is still there.
4. Disconnect the microphone during a recording, for example a headset. Check
   that the problem is reported and the recorded part is kept.
5. On a desktop, close the tab during a recording, open the page again and check
   that the recorded part can be recovered.

The release checks use iOS Safari, Android Chrome and desktop Chrome, Firefox
and Safari. In the pull request, write the browser, its version, the operating
system, the device and the source (audio, video or screen) you tested with.

## Pull request checklist

Use the pull request template. Before you ask for a review, check that:

- The description links the issue with `Closes #N`.
- `pnpm check` passes.
- Tests are added or updated.
- The docs are updated when the behavior changes.
- Recording changes include the results from a real device.

## Reporting bugs and security problems

Report a bug by opening an issue with the bug report form. Include the browser,
its version, the operating system, the device and the source kind.

Do not report security problems in a public issue. Read the
[security policy](SECURITY.md) instead.

## License

The project is released under the MIT license. See [LICENSE](LICENSE).
