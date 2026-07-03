import { eof, makeReader, readLengthDelimited, readString, readTag, readVarint, skipField } from './protobuf';

export type DomainType = 'plain' | 'regex' | 'domain' | 'full';

export interface DomainEntry {
  type: DomainType;
  value: string;
}

export interface GeoSiteEntry {
  countryCode: string;
  domains: DomainEntry[];
}

const DOMAIN_TYPES: DomainType[] = ['plain', 'regex', 'domain', 'full'];

function parseDomain(buf: Uint8Array): DomainEntry {
  const r = makeReader(buf);
  let type: DomainType = 'plain';
  let value = '';
  while (!eof(r)) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 0) {
      type = DOMAIN_TYPES[readVarint(r)] ?? 'plain';
    } else if (fieldNumber === 2 && wireType === 2) {
      value = readString(r);
    } else {
      skipField(r, wireType);
    }
  }
  return { type, value };
}

function parseGeoSite(buf: Uint8Array): GeoSiteEntry {
  const r = makeReader(buf);
  let countryCode = '';
  const domains: DomainEntry[] = [];
  while (!eof(r)) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 2) {
      countryCode = readString(r);
    } else if (fieldNumber === 2 && wireType === 2) {
      domains.push(parseDomain(readLengthDelimited(r)));
    } else {
      skipField(r, wireType);
    }
  }
  return { countryCode, domains };
}

export function parseGeoSiteList(buf: Uint8Array): GeoSiteEntry[] {
  const r = makeReader(buf);
  const entries: GeoSiteEntry[] = [];
  while (!eof(r)) {
    const { fieldNumber, wireType } = readTag(r);
    if (fieldNumber === 1 && wireType === 2) {
      entries.push(parseGeoSite(readLengthDelimited(r)));
    } else {
      skipField(r, wireType);
    }
  }
  return entries;
}

export interface GeoSiteIndex {
  byCategory: Map<string, GeoSiteEntry>;
  byValue: Map<string, { full: Set<string>; domain: Set<string> }>;
  plainRules: Array<{ category: string; value: string }>;
  regexRules: Array<{ category: string; value: string; re: RegExp }>;
}

export function buildGeoSiteIndex(entries: GeoSiteEntry[]): GeoSiteIndex {
  const byCategory = new Map<string, GeoSiteEntry>();
  const byValue = new Map<string, { full: Set<string>; domain: Set<string> }>();
  const plainRules: Array<{ category: string; value: string }> = [];
  const regexRules: Array<{ category: string; value: string; re: RegExp }> = [];

  for (const entry of entries) {
    const category = entry.countryCode.toLowerCase();
    byCategory.set(category, entry);

    for (const d of entry.domains) {
      const value = d.value.toLowerCase();
      if (d.type === 'full' || d.type === 'domain') {
        let bucket = byValue.get(value);
        if (!bucket) {
          bucket = { full: new Set(), domain: new Set() };
          byValue.set(value, bucket);
        }
        bucket[d.type].add(category);
      } else if (d.type === 'plain') {
        plainRules.push({ category, value });
      } else {
        // Some community geosite.dat entries carry non-standard regex that
        // fails to compile; skip those individually instead of aborting the
        // whole index build.
        try {
          regexRules.push({ category, value: d.value, re: new RegExp(d.value, 'i') });
        } catch {
          // ignore malformed regex entry
        }
      }
    }
  }

  return { byCategory, byValue, plainRules, regexRules };
}

export function matchDomain(index: GeoSiteIndex, inputDomain: string): string[] {
  const domain = inputDomain.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return [];

  const matched = new Set<string>();
  const labels = domain.split('.');
  const candidates = labels.map((_, i) => labels.slice(i).join('.'));

  const fullBucket = index.byValue.get(candidates[0]);
  if (fullBucket) {
    for (const c of fullBucket.full) matched.add(c);
  }
  for (const candidate of candidates) {
    const bucket = index.byValue.get(candidate);
    if (bucket) {
      for (const c of bucket.domain) matched.add(c);
    }
  }

  for (const rule of index.plainRules) {
    if (domain.includes(rule.value)) matched.add(rule.category);
  }
  for (const rule of index.regexRules) {
    if (rule.re.test(domain)) matched.add(rule.category);
  }

  return [...matched].sort();
}

export function getCategoryDomains(index: GeoSiteIndex, category: string): DomainEntry[] {
  return index.byCategory.get(category.toLowerCase())?.domains ?? [];
}

export function listCategories(index: GeoSiteIndex): string[] {
  return [...index.byCategory.keys()].sort();
}
