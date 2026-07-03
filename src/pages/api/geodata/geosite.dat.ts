import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { GEOSITE_OBJECT_KEY } from '../../../lib/geodata/constants';
import { buildCacheHeaders } from '../../../lib/geodata/r2Headers';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const object = await env.GEODATA.get(GEOSITE_OBJECT_KEY, { onlyIf: request.headers });

  if (object === null) {
    return new Response('Not found', { status: 404 });
  }

  const headers = buildCacheHeaders(object);

  if (!('body' in object)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
};
