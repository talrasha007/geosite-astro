// R2Object/R2ObjectBody are ambient types from worker-configuration.d.ts.
export function buildCacheHeaders(obj: R2Object): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=3600, must-revalidate');
  return headers;
}
