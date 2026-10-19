const UUID_BYTE_COUNT = 16;
const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;

// RFC 4122 section 4.4: the high nibble of byte 6 is the version and the top
// two bits of byte 8 are the variant.
function setVersionAndVariantBits(byte: number, byteIndex: number): number {
    if (byteIndex === VERSION_BYTE_INDEX) {
        return (byte & 0x0f) | 0x40;
    }

    if (byteIndex === VARIANT_BYTE_INDEX) {
        return (byte & 0x3f) | 0x80;
    }

    return byte;
}

function toHexByte(byte: number): string {
    const hex = byte.toString(16);

    return hex.padStart(2, '0');
}

function createUuidFromRandomValues(): string {
    const randomBytes = new Uint8Array(UUID_BYTE_COUNT);

    crypto.getRandomValues(randomBytes);

    const uuidBytes = Array.from(randomBytes, setVersionAndVariantBits);
    const hexBytes = uuidBytes.map(toHexByte);
    const hex = hexBytes.join('');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createRecordingId(): string {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return createUuidFromRandomValues();
}

export { createRecordingId };
