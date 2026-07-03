// Minimal protobuf wire-format reader, tailored to the geosite.dat/geoip.dat
// schema (only varint and length-delimited fields are ever produced by it,
// but skipField handles all wire types for forward-compat / unknown fields).

export interface Reader {
  buf: Uint8Array;
  pos: number;
}

export function makeReader(buf: Uint8Array): Reader {
  return { buf, pos: 0 };
}

export function eof(r: Reader): boolean {
  return r.pos >= r.buf.length;
}

// Uses multiplication instead of bitwise shifts so values aren't truncated
// to 32 bits once the shift exceeds 31 (lengths/field values here always fit
// well within Number.MAX_SAFE_INTEGER).
export function readVarint(r: Reader): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = r.buf[r.pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return result;
}

export function readTag(r: Reader): { fieldNumber: number; wireType: number } {
  const tag = readVarint(r);
  return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
}

// Copies the bytes rather than returning a subarray view, so parsed pieces
// (e.g. CIDR ip bytes) don't keep the whole multi-MB file buffer alive.
export function readBytes(r: Reader, len: number): Uint8Array {
  const bytes = r.buf.slice(r.pos, r.pos + len);
  r.pos += len;
  return bytes;
}

export function readLengthDelimited(r: Reader): Uint8Array {
  const len = readVarint(r);
  return readBytes(r, len);
}

const utf8Decoder = new TextDecoder('utf-8');

export function readString(r: Reader): string {
  return utf8Decoder.decode(readLengthDelimited(r));
}

export function skipField(r: Reader, wireType: number): void {
  switch (wireType) {
    case 0: // varint
      readVarint(r);
      break;
    case 1: // 64-bit fixed
      r.pos += 8;
      break;
    case 2: // length-delimited
      readLengthDelimited(r);
      break;
    case 5: // 32-bit fixed
      r.pos += 4;
      break;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}
