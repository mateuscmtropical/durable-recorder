# Coding standards

These rules keep the code easy to read and review. Most of them are enforced by
ESLint (`pnpm lint`). The rest are checked in code review.

## Variables

- Declare `const` first, then `let`. Prefer `const` and reach for `let` only
  when the value really changes.
- Never use `var` (lint).

```ts
const chunks: ArrayBuffer[] = [];
const startedAt = Date.now();
let totalBytes = 0;
```

## Names

Names say what the value is or what the function does. Avoid abbreviations
and single letters (lint allows `_` for unused parameters only).

| Avoid | Prefer |
|---|---|
| `getVal()` | `getRecordingCurrentSize()` |
| `calc(x)` | `calculateRemainingSeconds(elapsedSeconds)` |
| `d`, `tmp`, `res` | `durationSeconds`, `pendingChunk`, `storedRecording` |
| `cb` | `onProblem` |

- Functions and variables: `camelCase`. Types, interfaces, enums and classes:
  `PascalCase`. Module level constants: `UPPER_CASE`.
- Booleans read as a question: `isPaused`, `hasData`, `canContinue`.
- Files that export a class or interface use its name (`RecordingStore.ts`).
  Other files use the main function name (`pickMimeType.ts`).

## Method chains

When more than one method is chained, put each call on its own line (lint).

```ts
stream.getTracks()
    .forEach(stopTrack);

const mimeType = rawMimeType.split(';')[0]
    .trim();
```

## Calls as arguments

Do not pass the result of one call straight into another. Save it in a named
`const` first and pass the const (lint). Callbacks are fine.

```ts
// Avoid
const tracks = await Promise.all(inputs.map(readPrimaryTrack));

// Prefer
const tracksPromises = inputs.map(readPrimaryTrack);
const tracks = await Promise.all(tracksPromises);
```

## Arrays and loops

- Use array methods (`map`, `filter`, `forEach`, `reduce`, `some`, `every`,
  `find`) instead of loops.
- `for`, `while` and `do...while` are allowed only when array methods cannot do
  the job, for example `for await` over an async iterator. Disable the lint
  rule on that line and explain why in the comment.
- Run independent async work in parallel with `Promise.all`. Use
  `Promise.allSettled` when one failure must not cancel the others.

## Functions

- Small functions with one job. Prefer early returns over nested `if` blocks.
- Exported functions declare their return type (lint).
- Do not swallow errors silently. If an error is expected and safe to ignore,
  say why in a comment.

## Types

- Strict TypeScript. No `any`. Prefer `unknown` and narrow it.
- Use `import type` for type only imports (lint).
- Prefer interfaces for object shapes and string literal unions for small sets
  of values that cross the public API.

## Formatting

- 4 spaces, single quotes, semicolons, trailing commas on multiline literals.
- A blank line before `return` and after a block of declarations (lint).
- Run `pnpm lint:fix` before committing.

## Comments

Write comments for the reason behind the code, not for what the code says.
Browser workarounds always cite the bug or the browser version they target.

```ts
// Storing Blob values in IndexedDB is unreliable on iOS Safari (see
// docs/BROWSER_SUPPORT.md), so slices are stored as ArrayBuffer.
```

## Tests

- Every module with logic ships with tests next to it (`name.test.ts`).
- Test names describe behavior: `it('stops when the byte limit is reached')`.
- Tests may use nested calls inside `expect(...)`, the nested call rule only
  applies to source files.

## Commits and pull requests

- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`,
  `refactor:`, with a scope when it helps (`feat(storage): ...`).
- One logical change per pull request. `pnpm check` must pass.
