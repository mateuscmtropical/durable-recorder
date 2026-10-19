import { readFile } from 'node:fs/promises';

const FIXTURES_DIRECTORY = new URL('../fixtures/', import.meta.url);

// Reads a real recording from test/fixtures. The caller passes the MIME type
// the browser would have given the Blob, so tests can check the type output.
export async function loadFixture(fileName: string, mimeType: string): Promise<Blob> {
    const fixturePath = new URL(fileName, FIXTURES_DIRECTORY);
    const bytes = await readFile(fixturePath);

    return new Blob([bytes], { type: mimeType });
}
