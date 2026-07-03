import { GEOIP_ROUTE, GEOSITE_ROUTE } from '../lib/geodata/constants';
import { fetchWithCache } from '../lib/geodata/cacheFetch';
import { buildGeoIPIndex, getCategoryCidrs, listCategories as listGeoIpCategories, matchIp, parseGeoIPList, type GeoIPIndex } from '../lib/geodata/geoip';
import { buildGeoSiteIndex, getCategoryDomains, listCategories as listGeoSiteCategories, matchDomain, parseGeoSiteList, type GeoSiteIndex } from '../lib/geodata/geosite';
import type { ProgressStage, WorkerRequest, WorkerResponse } from '../lib/geodata/workerClient';

let geoSiteIndex: GeoSiteIndex | null = null;
let geoIpIndex: GeoIPIndex | null = null;
let geoSiteLoading: Promise<GeoSiteIndex> | null = null;
let geoIpLoading: Promise<GeoIPIndex> | null = null;

function postProgress(kind: 'geosite' | 'geoip', stage: ProgressStage): void {
  self.postMessage({ type: 'progress', kind, stage } satisfies WorkerResponse);
}

function ensureGeoSiteLoaded(): Promise<GeoSiteIndex> {
  if (geoSiteIndex) return Promise.resolve(geoSiteIndex);
  if (!geoSiteLoading) {
    geoSiteLoading = (async () => {
      postProgress('geosite', 'downloading');
      const buf = await fetchWithCache(GEOSITE_ROUTE);
      postProgress('geosite', 'parsing');
      const index = buildGeoSiteIndex(parseGeoSiteList(new Uint8Array(buf)));
      geoSiteIndex = index;
      postProgress('geosite', 'ready');
      return index;
    })();
  }
  return geoSiteLoading;
}

function ensureGeoIpLoaded(): Promise<GeoIPIndex> {
  if (geoIpIndex) return Promise.resolve(geoIpIndex);
  if (!geoIpLoading) {
    geoIpLoading = (async () => {
      postProgress('geoip', 'downloading');
      const buf = await fetchWithCache(GEOIP_ROUTE);
      postProgress('geoip', 'parsing');
      const index = buildGeoIPIndex(parseGeoIPList(new Uint8Array(buf)));
      geoIpIndex = index;
      postProgress('geoip', 'ready');
      return index;
    })();
  }
  return geoIpLoading;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    let result: unknown;
    switch (req.type) {
      case 'matchDomain':
        result = matchDomain(await ensureGeoSiteLoaded(), req.domain);
        break;
      case 'matchIp':
        result = matchIp(await ensureGeoIpLoaded(), req.ip);
        break;
      case 'listGeoSiteCategories':
        result = listGeoSiteCategories(await ensureGeoSiteLoaded());
        break;
      case 'listGeoIpCategories':
        result = listGeoIpCategories(await ensureGeoIpLoaded());
        break;
      case 'getCategoryDomains':
        result = getCategoryDomains(await ensureGeoSiteLoaded(), req.category);
        break;
      case 'getCategoryCidrs':
        result = getCategoryCidrs(await ensureGeoIpLoaded(), req.category);
        break;
    }
    self.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    self.postMessage({ id: req.id, ok: false, error } satisfies WorkerResponse);
  }
};
