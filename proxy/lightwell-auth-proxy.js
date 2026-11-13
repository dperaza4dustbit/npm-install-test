#!/usr/bin/env node
/**
 * Dual-registry npm proxy for Lightwell validated packages.
 *
 * REFERENCE implementation. The harness default is Verdaccio
 * (`PROXY_IMPL=verdaccio` in scripts/run.sh). Keep this file for comparison /
 * debugging; run it with `PROXY_IMPL=custom`.
 *
 * Dumb auth passthrough (customer contract):
 *   1. Try Lightwell (Basic auth; strip Authorization on cross-host redirects)
 *   2. On 404, fall back to UPSTREAM_REGISTRY_URL (default registry.npmjs.org)
 *   3. Rewrite absolute tarball hosts onto this proxy so clients download via us
 *   4. Optionally merge npmjs packument version sets so dual-registry ranges can
 *      still resolve community versions Lightwell does not host (Lightwell docs win)
 *
 * Pulp packument-expand / integrity-recompute workarounds were removed after the
 * pulp_npm full-manifest fix. See docs/pulp-npm-packument-requirement.md.
 *
 * Listen: LIGHTWELL_AUTH_PROXY_BIND:LIGHTWELL_AUTH_PROXY_PORT (default 0.0.0.0:4874)
 * Client-facing base for rewritten dist.tarball: PROXY_PUBLIC_URL
 *   (default http://127.0.0.1:$PORT — set to http://<proxy-hostname>:4874 on Docker networks)
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const LISTEN_PORT = Number(process.env.LIGHTWELL_AUTH_PROXY_PORT || 4874);
const LISTEN_BIND = process.env.LIGHTWELL_AUTH_PROXY_BIND || '0.0.0.0';
const PUBLIC_BASE = (
  process.env.PROXY_PUBLIC_URL || `http://127.0.0.1:${LISTEN_PORT}`
).replace(/\/$/, '');
const TARGET = (
  process.env.LIGHTWELL_REGISTRY_URL ||
  'https://packages.redhat.com/lightwell/javascript/validated'
).replace(/\/$/, '');
const UPSTREAM_NPM = (process.env.UPSTREAM_REGISTRY_URL || 'https://registry.npmjs.org').replace(
  /\/$/,
  '',
);
const USER = process.env.SERVICE_ACCOUNT_USERNAME || '';
const PASS = process.env.SERVICE_ACCOUNT_PASSWORD || '';
const MISS_LOG = process.env.PROXY_MISS_LOG || '/tmp/npm-proxy-misses.jsonl';
// Default on: packages.redhat.com CDN can keep serving pre-replace .tgz bytes
// for a while after ALLOW_CONTENT_REPLACE. Bust query + no-cache so the test
// harness sees the new artifact. Set PROXY_BYPASS_CDN_CACHE=0 to disable.
const BYPASS_CDN_CACHE = process.env.PROXY_BYPASS_CDN_CACHE !== '0';

if (!USER || !PASS) {
  console.error('dual-registry-proxy: SERVICE_ACCOUNT_USERNAME/PASSWORD required');
  process.exit(1);
}

const basic = Buffer.from(`${USER}:${PASS}`).toString('base64');
const targetBase = new URL(TARGET + '/');
const pulpOrigin = `${targetBase.protocol}//${targetBase.host}`;

/**
 * Append a unique query param so Akamai/CDN treats the GET as a new cache key.
 * Must also run on redirect targets (cdn.*.redhat.com etc.).
 */
function withCdnBust(url) {
  if (!BYPASS_CDN_CACHE) return url;
  const u = new URL(url);
  u.searchParams.set('_cb', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  return u.toString();
}

function defaultPort(u) {
  return u.protocol === 'https:' ? '443' : '80';
}

function resolveLightwell(reqUrl) {
  const path = reqUrl || '/';
  if (path.startsWith('/api/pulp-content/') || path.startsWith('/pulp/content/')) {
    return pulpOrigin + path;
  }
  return new URL(path.replace(/^\//, ''), targetBase).toString();
}

function resolveNpmjs(reqUrl) {
  return new URL((reqUrl || '/').replace(/^\//, ''), UPSTREAM_NPM + '/').toString();
}

/**
 * @param {boolean} withBasic - send Pulp Basic auth on packages.redhat.com only
 * @param {boolean} [bustCache] - CDN bust for this hop and every redirect
 */
function fetchOnce(url, headers, redirectCount, withBasic, bustCache) {
  const doBust = bustCache === undefined ? Boolean(withBasic) : Boolean(bustCache);
  return new Promise((resolve, reject) => {
    const fetchUrl = doBust ? withCdnBust(url) : url;
    const u = new URL(fetchUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const sameHost = u.hostname === targetBase.hostname;
    const reqHeaders = { ...headers, host: u.host };
    if (withBasic && sameHost) {
      reqHeaders.authorization = `Basic ${basic}`;
    } else {
      delete reqHeaders.authorization;
    }
    if (doBust) {
      reqHeaders['cache-control'] = 'no-cache, no-store, must-revalidate';
      reqHeaders.pragma = 'no-cache';
      reqHeaders.expires = '0';
    }

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || defaultPort(u),
        path: u.pathname + u.search,
        method: 'GET',
        headers: reqHeaders,
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          if (redirectCount >= 8) {
            reject(new Error(`too many redirects for ${url}`));
            res.resume();
            return;
          }
          const next = new URL(res.headers.location, u).toString();
          res.resume();
          const nextHost = new URL(next).hostname;
          const keepBasic = withBasic && nextHost === targetBase.hostname;
          fetchOnce(next, headers, redirectCount + 1, keepBasic, doBust).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (doBust && BYPASS_CDN_CACHE) {
            const edge = res.headers['x-rh-edge-cache-status'] || res.headers['x-cache'] || '';
            if (edge || u.pathname.endsWith('.tgz')) {
              console.error(
                `cdn-fetch status=${status} host=${u.hostname} edge="${edge}" path=${u.pathname}`,
              );
            }
          }
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function maybeDecode(body, headers) {
  const enc = (headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc.includes('gzip') || (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b)) {
      return zlib.gunzipSync(body);
    }
    if (enc.includes('deflate')) return zlib.inflateSync(body);
  } catch (_) {
    /* keep raw */
  }
  return body;
}

function rewriteAbsoluteRegistryHosts(text) {
  let out = text.replace(/https?:\/\/packages\.redhat\.com/g, PUBLIC_BASE);
  try {
    const upstreamHost = new URL(UPSTREAM_NPM).host;
    const re = new RegExp(`https?:\\/\\/${upstreamHost.replace(/\./g, '\\.')}`, 'g');
    out = out.replace(re, PUBLIC_BASE);
  } catch (_) {
    /* ignore bad UPSTREAM_REGISTRY_URL */
  }
  return out;
}

function isPackumentPath(pathOnly) {
  if (!pathOnly || pathOnly.endsWith('.tgz')) return false;
  if (pathOnly.startsWith('/-/')) return false;
  if (pathOnly.startsWith('/api/')) return false;
  const parts = pathOnly.replace(/^\//, '').split('/');
  if (parts[0].startsWith('@')) return parts.length === 2;
  return parts.length === 1;
}

async function mergeNpmjsPackument(lightwellDoc, packagePath, hdrs) {
  // Dual-registry only: Lightwell may list a subset of versions. Merge npmjs so
  // ranges can still resolve to community versions (tarball fetch 404→npmjs).
  try {
    const out = await fetchOnce(resolveNpmjs(packagePath), hdrs, 0, false);
    if (out.status !== 200) return lightwellDoc;
    const npmDoc = JSON.parse(maybeDecode(out.body, out.headers).toString('utf8'));
    if (!npmDoc.versions) return lightwellDoc;
    const merged = { ...npmDoc, ...lightwellDoc };
    merged.versions = { ...npmDoc.versions };
    for (const [ver, meta] of Object.entries(lightwellDoc.versions || {})) {
      merged.versions[ver] = meta;
    }
    if (lightwellDoc['dist-tags']) {
      merged['dist-tags'] = { ...(npmDoc['dist-tags'] || {}), ...lightwellDoc['dist-tags'] };
    }
    if (lightwellDoc.name) merged.name = lightwellDoc.name;
    return merged;
  } catch (err) {
    console.error(`merge npmjs ${packagePath}:`, err.message || err);
    return lightwellDoc;
  }
}

function logMiss(path) {
  fs.appendFileSync(MISS_LOG, JSON.stringify({ ts: new Date().toISOString(), path }) + '\n');
}

const server = http.createServer(async (req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    (pathOnly === '/' || pathOnly === '/-/ping')
  ) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 });
    res.end(req.method === 'HEAD' ? undefined : '{}');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('method not allowed');
    return;
  }

  const path = req.url || '/';
  const hdrs = {
    accept: req.headers.accept || '*/*',
    'user-agent': req.headers['user-agent'] || 'lightwell-dual-registry-proxy',
    'accept-encoding': 'identity',
  };

  try {
    const isTarball = pathOnly.endsWith('.tgz');

    const lwUrl = resolveLightwell(path);
    let out = await fetchOnce(lwUrl, hdrs, 0, true);
    let source = 'lightwell';

    if (out.status === 404) {
      logMiss(path);
      const npmUrl = resolveNpmjs(path);
      out = await fetchOnce(npmUrl, hdrs, 0, false);
      source = 'npmjs';
    }

    if (out.status === 401 || out.status === 403) {
      console.error(`${source} ${out.status} for ${path}`);
    }

    let raw = isTarball ? out.body : maybeDecode(out.body, out.headers);
    let ct = out.headers['content-type'] || 'application/octet-stream';

    const looksJson =
      !isTarball &&
      ((raw.length > 0 && (raw[0] === 0x7b || raw[0] === 0x5b)) || ct.includes('json'));

    if (looksJson && out.status === 200) {
      let text = raw.toString('utf8');
      text = rewriteAbsoluteRegistryHosts(text);
      if (source === 'lightwell' && isPackumentPath(pathOnly)) {
        try {
          const doc = await mergeNpmjsPackument(JSON.parse(text), pathOnly, hdrs);
          text = rewriteAbsoluteRegistryHosts(JSON.stringify(doc));
        } catch (err) {
          console.error(`packument merge failed for ${pathOnly}:`, err.message || err);
        }
      }
      raw = Buffer.from(text, 'utf8');
      ct = 'application/json; charset=utf-8';
    }

    res.writeHead(out.status, {
      'content-type': ct,
      'content-length': raw.length,
      'x-npm-proxy-source': source,
    });
    res.end(req.method === 'HEAD' ? undefined : raw);
  } catch (err) {
    console.error('proxy error', path, err);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(String(err && err.message ? err.message : err));
  }
});

fs.writeFileSync(MISS_LOG, '');
server.listen(LISTEN_PORT, LISTEN_BIND, () => {
  console.log(`dual-registry proxy on ${LISTEN_BIND}:${LISTEN_PORT}`);
  console.log(`  public:    ${PUBLIC_BASE}`);
  console.log(`  lightwell: ${TARGET}`);
  console.log(`  upstream:  ${UPSTREAM_NPM}`);
  console.log(`  miss log:  ${MISS_LOG}`);
  console.log(
    `  cdn bust:  ${BYPASS_CDN_CACHE ? 'on (_cb + no-cache, incl. redirect/CDN hosts)' : 'off'}`,
  );
});
