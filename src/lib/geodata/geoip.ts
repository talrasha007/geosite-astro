import { eof, makeReader, readLengthDelimited, readString, readTag, readVarint, skipField } from './protobuf';

export interface CidrEntry {
  ip: Uint8Array; // 4 bytes (IPv4) or 16 bytes (IPv6)
  prefix: number;
}

export interface GeoIPEntry {
  countryCode: string;
  cidrs: CidrEntry[];
  inverseMatch: boolean;
  reverseMatch: boolean;
}

function parseCidr(buf: Uint8Array): CidrEntry {
  const r = makeReader(buf);
  let ip: Uint8Array = new Uint8Array(0);
  let prefix = 0;
  while (!eof(r)) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 2) {
      ip = readLengthDelimited(r);
    } else if (fieldNumber === 2 && wireType === 0) {
      prefix = readVarint(r);
    } else {
      skipField(r, wireType);
    }
  }
  return { ip, prefix };
}

function parseGeoIP(buf: Uint8Array): GeoIPEntry {
  const r = makeReader(buf);
  let countryCode = '';
  const cidrs: CidrEntry[] = [];
  let inverseMatch = false;
  let reverseMatch = false;
  while (!eof(r)) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 2) {
      countryCode = readString(r);
    } else if (fieldNumber === 2 && wireType === 2) {
      cidrs.push(parseCidr(readLengthDelimited(r)));
    } else if (fieldNumber === 3 && wireType === 0) {
      inverseMatch = readVarint(r) !== 0;
    } else if (fieldNumber === 4 && wireType === 0) {
      reverseMatch = readVarint(r) !== 0;
    } else {
      skipField(r, wireType);
    }
  }
  return { countryCode, cidrs, inverseMatch, reverseMatch };
}

export function parseGeoIPList(buf: Uint8Array): GeoIPEntry[] {
  const r = makeReader(buf);
  const entries: GeoIPEntry[] = [];
  while (!eof(r)) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 2) {
      entries.push(parseGeoIP(readLengthDelimited(r)));
    } else {
      skipField(r, wireType);
    }
  }
  return entries;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

export interface IpRange {
  start: bigint;
  end: bigint;
}

export function cidrToRange(entry: CidrEntry): { start: bigint; end: bigint; version: 4 | 6 } {
  const totalBits = entry.ip.length === 16 ? 128 : 32;
  const version = totalBits === 128 ? 6 : 4;
  const ipInt = bytesToBigInt(entry.ip);
  const fullMask = (1n << BigInt(totalBits)) - 1n;
  const hostBits = totalBits - entry.prefix;
  const hostMask = (1n << BigInt(hostBits)) - 1n;
  const start = ipInt & (fullMask ^ hostMask);
  const end = start | hostMask;
  return { start, end, version };
}

export interface GeoIPIndex {
  byCategory: Map<string, { entry: GeoIPEntry; v4: IpRange[]; v6: IpRange[] }>;
}

function compareRanges(a: IpRange, b: IpRange): number {
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  return 0;
}

export function buildGeoIPIndex(entries: GeoIPEntry[]): GeoIPIndex {
  const byCategory = new Map<string, { entry: GeoIPEntry; v4: IpRange[]; v6: IpRange[] }>();
  for (const entry of entries) {
    const category = entry.countryCode.toLowerCase();
    const v4: IpRange[] = [];
    const v6: IpRange[] = [];
    for (const cidr of entry.cidrs) {
      const { start, end, version } = cidrToRange(cidr);
      (version === 4 ? v4 : v6).push({ start, end });
    }
    v4.sort(compareRanges);
    v6.sort(compareRanges);
    byCategory.set(category, { entry, v4, v6 });
  }
  return { byCategory };
}

function rangesContain(ranges: IpRange[], value: bigint): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (value < range.start) hi = mid - 1;
    else if (value > range.end) lo = mid + 1;
    else return true;
  }
  return false;
}

export function matchIp(index: GeoIPIndex, ip: string): string[] {
  const parsed = ipToBigInt(ip);
  if (!parsed) return [];
  const matched: string[] = [];
  for (const [category, data] of index.byCategory) {
    const ranges = parsed.version === 4 ? data.v4 : data.v6;
    if (rangesContain(ranges, parsed.value)) matched.push(category);
  }
  return matched.sort();
}

export function getCategoryCidrs(index: GeoIPIndex, category: string): CidrEntry[] {
  return index.byCategory.get(category.toLowerCase())?.entry.cidrs ?? [];
}

export function listCategories(index: GeoIPIndex): string[] {
  return [...index.byCategory.keys()].sort();
}

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(ip: string): Uint8Array | null {
  if (ip.includes('%')) return null; // zone IDs not supported

  let addr = ip;
  let embeddedV4: Uint8Array | null = null;
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    embeddedV4 = parseIpv4(tail);
    if (!embeddedV4) return null;
    addr = `${addr.slice(0, lastColon + 1)}0:0`; // stand-in for the 4 bytes, filled in below
  }

  if ((addr.match(/::/g) ?? []).length > 1) return null;

  let headPart: string;
  let tailPart: string;
  const hasCompression = addr.includes('::');
  if (hasCompression) {
    const [h, t] = addr.split('::');
    headPart = h;
    tailPart = t;
  } else {
    headPart = addr;
    tailPart = '';
  }

  const headGroups = headPart.length ? headPart.split(':') : [];
  const tailGroups = tailPart.length ? tailPart.split(':') : [];

  if (!hasCompression && headGroups.length !== 8) return null;
  if (headGroups.length + tailGroups.length > 8) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...(hasCompression ? Array(missing).fill('0') : []), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }

  if (embeddedV4) bytes.set(embeddedV4, 12);

  return bytes;
}

export function ipToBigInt(ip: string): { value: bigint; version: 4 | 6 } | null {
  const trimmed = ip.trim();
  const v4 = parseIpv4(trimmed);
  if (v4) return { value: bytesToBigInt(v4), version: 4 };
  const v6 = parseIpv6(trimmed);
  if (v6) return { value: bytesToBigInt(v6), version: 6 };
  return null;
}

export function looksLikeIp(input: string): boolean {
  return ipToBigInt(input) !== null;
}
