#!/usr/bin/env node
/**
 * Dual-registry npm proxy for Lightwell validated packages.
 *
 * Long-term customer contract is a dumb auth passthrough (Basic + optional
 * npmjs 404 fallback + rewrite absolute tarball hosts onto this proxy).
 * Steps 3–4 below are TEMPORARY workarounds for pulp_npm stub packuments —
 * see docs/pulp-npm-packument-requirement.md and pulp_npm#435 / #438.
 * Remove them once Pulp serves full manifests + correct dist.integrity.
 *
 *   1. Try Lightwell Pulp (Basic auth; strip Authorization on cross-host redirects)
 *   2. On 404, fall back to UPSTREAM_REGISTRY_URL (default registry.npmjs.org)
 *   3. WORKAROUND: expand stub Pulp packuments from the validated .tgz
 *      (read package/package.json — not upstream metadata)
 *   4. WORKAROUND: recompute dist.integrity from those .tgz bytes
 *
 * Why not Verdaccio alone for Pulp?
 * Verdaccio stores absolute dist.tarball URLs from uplink metadata and later
 * downloads those hosts directly — without uplink credentials — so
 * packages.redhat.com tarball GETs return 401.
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
  'https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated'
).replace(/\/$/, '');
const UPSTREAM_NPM = (process.env.UPSTREAM_REGISTRY_URL || 'https://registry.npmjs.org').replace(/\/$/, '');
const USER = process.env.SERVICE_ACCOUNT_USERNAME || '';
const PASS = process.env.SERVICE_ACCOUNT_PASSWORD || '';
const MISS_LOG = process.env.PROXY_MISS_LOG || '/tmp/npm-proxy-misses.jsonl';
// Default on: packages.redhat.com CDN can keep serving pre-replace .tgz bytes
// for a while after ALLOW_CONTENT_REPLACE. Bust query + no-cache so the test
// harness sees the new artifact. Set PROXY_BYPASS_CDN_CACHE=0 to disable.
const BYPASS_CDN_CACHE = process.env.PROXY_BYPASS_CDN_CACHE !== '0';
// Pin Lightwell .tgz bytes in-memory so packument dist.integrity (computed at
// expand time) matches the later .tgz GET. Without this, CDN bust can make
// those two hops hash differently → npm EINTEGRITY (seen on body-parser →
// on-finished). Expand always refreshes the pin; .tgz GETs reuse it.
const TARBALL_PIN_TTL_MS = Math.max(
  0,
  Number(process.env.PROXY_TARBALL_PIN_TTL_MS || 600000),
);

if (!USER || !PASS) {
  console.error('dual-registry-proxy: SERVICE_ACCOUNT_USERNAME/PASSWORD required');
  process.exit(1);
}

const basic = Buffer.from(`${USER}:${PASS}`).toString('base64');
const targetBase = new URL(TARGET + '/');
const pulpOrigin = `${targetBase.protocol}//${targetBase.host}`;

/** @type {Map<string, { body: Buffer, integrity: string, at: number }>} */
const tarballPin = new Map();

function pinKeyFromPath(p) {
  const path = (p || '').split('?')[0];
  const base = path.split('/').filter(Boolean).pop();
  return base || path.replace(/^\//, '');
}

function getPinnedTarball(pathOrUrl) {
  const key = pinKeyFromPath(pathOrUrl);
  if (!key || TARBALL_PIN_TTL_MS === 0) return null;
  const hit = tarballPin.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TARBALL_PIN_TTL_MS) {
    tarballPin.delete(key);
    return null;
  }
  return hit;
}

function setPinnedTarball(pathOrUrl, body) {
  const key = pinKeyFromPath(pathOrUrl);
  if (!key || !body || !Buffer.isBuffer(body)) return null;
  const entry = { body, integrity: sriSha512(body), at: Date.now() };
  tarballPin.set(key, entry);
  return entry;
}

/**
 * Append a unique query param so Akamai/CDN treats the GET as a new cache key.
 * Must also run on redirect targets (cdn.*.redhat.com etc.): Location rarely
 * preserves our `_cb`, and the edge host is not packages.redhat.com — that was
 * why bust looked like a no-op until TTL expired.
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
 * @param {boolean} [bustCache] - CDN bust for this hop and every redirect; defaults
 *   to withBasic so Lightwell fetches bust and npmjs fallback does not
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
    // Apply no-cache on the edge hop too — that is where stale .tgz lived.
    // Note: Akamai may still serve path-keyed objects until TTL/purge; bust is best-effort.
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
          // Keep doBust across CDN redirects even when Basic auth is dropped.
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

/**
 * WORKAROUND detector for pulp_npm stub version objects.
 * Real npm (abbreviated) version docs include dependencies / optionalDependencies / etc.
 * Pulp today often only has _id + dist (+ name/version after small pulp fixes).
 */
function isStubVersion(v) {
  if (!v || typeof v !== 'object') return true;
  const keys = Object.keys(v);
  return keys.every((k) => k === '_id' || k === 'dist' || k === 'name' || k === 'version');
}

function isPackumentPath(pathOnly) {
  if (!pathOnly || pathOnly.endsWith('.tgz')) return false;
  if (pathOnly.startsWith('/-/')) return false;
  if (pathOnly.startsWith('/api/')) return false;
  // /name or /@scope/name  — not /name/version
  const parts = pathOnly.replace(/^\//, '').split('/');
  if (parts[0].startsWith('@')) return parts.length === 2; // @scope/name
  return parts.length === 1; // name
}

/**
 * npm often GETs /name/version (or /@scope/name/version) instead of the full
 * packument. Those must get the same integrity rewrite + tarball pin.
 */
function parseVersionMetadataPath(pathOnly) {
  if (!pathOnly || pathOnly.endsWith('.tgz')) return null;
  if (pathOnly.startsWith('/-/') || pathOnly.startsWith('/api/')) return null;
  const parts = pathOnly.replace(/^\//, '').split('/');
  if (parts[0].startsWith('@')) {
    if (parts.length === 3 && parts[2] && parts[2] !== '-') {
      return { name: `${parts[0]}/${parts[1]}`, version: parts[2] };
    }
    return null;
  }
  if (parts.length === 2 && parts[1] && parts[1] !== '-') {
    return { name: parts[0], version: parts[1] };
  }
  return null;
}

function tarballPathFromDist(dist, name, ver) {
  if (dist && dist.tarball) {
    try {
      const u = new URL(dist.tarball);
      return u.pathname + u.search;
    } catch (_) {
      /* fall through */
    }
  }
  const filename = `${name.split('/').pop()}-${ver}.tgz`;
  return `/${name}/-/${filename}`;
}

function sriSha512(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

/**
 * Fetch a Lightwell .tgz for packument expand and pin the bytes so the client's
 * subsequent tarball GET cannot race the CDN to a different digest.
 */
async function fetchLightwellTarball(dist, name, ver, hdrs) {
  const tbPath = tarballPathFromDist(dist, name, ver);
  try {
    const out = await fetchOnce(resolveLightwell(tbPath), hdrs, 0, true);
    if (out.status !== 200) return null;
    // Keep raw bytes (already .tgz); do not gunzip. Always refresh pin.
    const pin = setPinnedTarball(tbPath, out.body);
    return { path: tbPath, body: out.body, integrity: pin ? pin.integrity : sriSha512(out.body) };
  } catch (_) {
    return null;
  }
}

/**
 * Read one member from an npm .tgz (gzip+ustar) without writing to disk.
 */
function readTarGzipMember(tgzBuf, memberName) {
  const tar = zlib.gunzipSync(tgzBuf);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (fullName === memberName || name === memberName) {
      return tar.subarray(dataStart, dataEnd);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function packageJsonFromTarball(tgzBuf) {
  const raw = readTarGzipMember(tgzBuf, 'package/package.json');
  if (!raw) throw new Error('package/package.json missing from tarball');
  return JSON.parse(raw.toString('utf8'));
}

/**
 * Build a registry version document from the validated tarball's package.json.
 * That is the published truth (deps, optionals, bin, engines) — not npmjs.
 */
function versionDocFromTarball(pkg, stub, tarballPath, integrity) {
  const doc = { ...pkg };
  doc._id = stub._id || `${pkg.name}@${pkg.version}`;
  doc.dist = {
    ...(stub.dist || {}),
    integrity,
    tarball: `${PUBLIC_BASE}${tarballPath}`,
  };
  delete doc.dist.shasum;
  return doc;
}

async function mergeNpmjsPackument(lightwellDoc, packagePath, hdrs) {
  // Dual-registry only: Lightwell may list a subset of versions. Merge npmjs so
  // ranges can still resolve to community versions (tarball fetch 404→npmjs).
  // Validated version docs already come from the Lightwell .tgz and win on overlay.
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

/**
 * WORKAROUND for pulp_npm stub packuments (docs/pulp-npm-packument-requirement.md).
 * When every version is a stub, open the Lightwell .tgz, copy fields from
 * package/package.json, and set dist.integrity to sha512 of those bytes.
 * No-op once Pulp serves full manifests + generated integrity.
 */
/**
 * Force dist.integrity (+ pin) from the live Lightwell .tgz so Pulp/CDN cannot
 * advertise a stale SRI while serving different bytes.
 */
async function recomputeVersionIntegrity(doc, name, version, hdrs) {
  if (!doc || typeof doc !== 'object' || !doc.dist) return doc;
  const lwTb = await fetchLightwellTarball(doc.dist, name, version, hdrs);
  if (!lwTb) return doc;
  doc.dist = {
    ...doc.dist,
    integrity: lwTb.integrity || sriSha512(lwTb.body),
    tarball: `${PUBLIC_BASE}${lwTb.path}`,
  };
  delete doc.dist.shasum;
  return doc;
}

async function expandStubPackument(packument, packagePath, hdrs) {
  if (!packument || typeof packument !== 'object' || !packument.versions) return packument;
  const versions = packument.versions;
  const names = Object.keys(versions);
  if (!names.length) return packument;
  const stubs = names.every((ver) => isStubVersion(versions[ver]));

  const basePath = packagePath.replace(/\/$/, '');
  const pkgName = packument.name || basePath.replace(/^\//, '');

  if (stubs) {
    await Promise.all(
      names.map(async (ver) => {
        try {
          const stub = versions[ver] || {};
          if (!stub.dist) return;
          const lwTb = await fetchLightwellTarball(stub.dist, pkgName, ver, hdrs);
          if (!lwTb) {
            console.error(`expand ${basePath}@${ver}: Lightwell tarball missing`);
            return;
          }
          const pkg = packageJsonFromTarball(lwTb.body);
          versions[ver] = versionDocFromTarball(
            pkg,
            stub,
            lwTb.path,
            lwTb.integrity || sriSha512(lwTb.body),
          );
        } catch (err) {
          console.error(`expand ${basePath}@${ver}:`, err.message || err);
        }
      }),
    );
    return mergeNpmjsPackument(packument, basePath, hdrs);
  }

  // Non-stub Pulp manifests can still carry wrong dist.integrity after replace.
  await Promise.all(
    names.map(async (ver) => {
      try {
        versions[ver] = await recomputeVersionIntegrity(versions[ver], pkgName, ver, hdrs);
      } catch (err) {
        console.error(`integrity ${basePath}@${ver}:`, err.message || err);
      }
    }),
  );
  return packument;
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
    // .tgz files are already gzip; never gunzip them (npmjs often sets
    // Content-Encoding: gzip on the wire, which would double-decompress).
    const isTarball = pathOnly.endsWith('.tgz');

    // Prefer pinned Lightwell bytes (same digest as packument expand).
    if (isTarball) {
      const pin = getPinnedTarball(pathOnly);
      if (pin) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': pin.body.length,
          'x-npm-proxy-source': 'lightwell-pin',
          'x-npm-proxy-integrity': pin.integrity,
        });
        res.end(req.method === 'HEAD' ? undefined : pin.body);
        return;
      }
    }

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

    if (isTarball && out.status === 200 && source === 'lightwell') {
      setPinnedTarball(pathOnly, raw);
    }

    const looksJson =
      !isTarball &&
      ((raw.length > 0 && (raw[0] === 0x7b || raw[0] === 0x5b)) || ct.includes('json'));

    if (looksJson && out.status === 200) {
      let text = raw.toString('utf8');
      if (source === 'lightwell') {
        text = rewriteAbsoluteRegistryHosts(text);
        try {
          let doc = JSON.parse(text);
          if (isPackumentPath(pathOnly)) {
            doc = await expandStubPackument(doc, pathOnly, hdrs);
            // Re-apply host rewrite after merge (version docs have absolute tarball URLs).
            text = rewriteAbsoluteRegistryHosts(JSON.stringify(doc));
          } else {
            const verMeta = parseVersionMetadataPath(pathOnly);
            if (verMeta) {
              doc = await recomputeVersionIntegrity(doc, verMeta.name, verMeta.version, hdrs);
              text = rewriteAbsoluteRegistryHosts(JSON.stringify(doc));
            }
          }
        } catch (err) {
          console.error(`packument rewrite failed for ${pathOnly}:`, err.message || err);
        }
      } else {
        text = rewriteAbsoluteRegistryHosts(text);
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
  console.log(
    `  tarball pin: ${TARBALL_PIN_TTL_MS === 0 ? 'off' : `on (ttl ${TARBALL_PIN_TTL_MS}ms)`}`,
  );
});
