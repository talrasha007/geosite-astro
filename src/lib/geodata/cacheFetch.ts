export const GEODATA_CACHE_NAME = 'geodata-v1';

// Persists the raw .dat bytes across sessions via the Cache API, revalidating
// against the R2-backed route's ETag so unchanged files aren't re-downloaded.
export async function fetchWithCache(url: string): Promise<ArrayBuffer> {
  const cache = await caches.open(GEODATA_CACHE_NAME);
  const cached = await cache.match(url);

  const etag = cached?.headers.get('etag');
  const response = await fetch(url, etag ? { headers: { 'if-none-match': etag } } : undefined);

  if (response.status === 304 && cached) {
    return cached.arrayBuffer();
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  await cache.put(url, response.clone());
  return response.arrayBuffer();
}
