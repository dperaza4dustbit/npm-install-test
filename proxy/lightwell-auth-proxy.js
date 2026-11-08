#!/usr/bin/env node
/**
 * Dual-registry npm proxy for Lightwell validated packages.
 *
 * Long-term customer contract is a dumb auth passthrough (Basic + optional
 * npmjs 404 fallback + rewrite absolute tarball hosts onto this proxy).
 * Steps 3–5 below are TEMPORARY workarounds for pulp_npm stub packuments
 * and @lightwell Tier B naming — see docs/pulp-npm-packument-requirement.md
 * and pulp_npm#435 / #438. Remove them once Pulp serves full manifests +
 * correct dist.integrity and Tier B publishes under @esbuild / @typescript.
 *
 *   1. Try Lightwell Pulp (Basic auth; strip Authorization on cross-host redirects)
 *   2. On 404, fall back to registry.npmjs.org
 *   3. WORKAROUND: expand stub Pulp packuments (_id+dist only) so npm sees deps
 *   4. WORKAROUND: recompute dist.integrity from Lightwell .tgz bytes
 *   5. WORKAROUND: remap @esbuild/@typescript natives → @lightwell/* (Tier B today)
 *
 * Why not Verdaccio alone for Pulp?
 * Verdaccio stores absolute dist.tarball URLs from uplink metadata and later
 * downloads those hosts directly — without uplink credentials — so
 * packages.redhat.com tarball GETs return 401.
 *
 * Listen: LIGHTWELL_AUTH_PROXY_PORT (default 4874)
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const LISTEN_PORT = Number(process.env.LIGHTWELL_AUTH_PROXY_PORT || 4874);
const TARGET = (
  process.env.LIGHTWELL_REGISTRY_URL ||
  'https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated'
).replace(/\/$/, '');
const UPSTREAM_NPM = (process.env.UPSTREAM_REGISTRY_URL || 'https://registry.npmjs.org').replace(/\/$/, '');
const USER = process.env.SERVICE_ACCOUNT_USERNAME || '';
const PASS = process.env.SERVICE_ACCOUNT_PASSWORD || '';
const MISS_LOG = process.env.PROXY_MISS_LOG || '/tmp/npm-proxy-misses.jsonl';

if (!USER || !PASS) {
  console.error('dual-registry-proxy: SERVICE_ACCOUNT_USERNAME/PASSWORD required');
  process.exit(1);
}

const basic = Buffer.from(`${USER}:${PASS}`).toString('base64');
const targetBase = new URL(TARGET + '/');
const pulpOrigin = `${targetBase.protocol}//${targetBase.host}`;

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

function fetchOnce(url, headers, redirectCount, withBasic) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const sameHost = u.hostname === targetBase.hostname;
    const reqHeaders = { ...headers, host: u.host };
    if (withBasic && sameHost) {
      reqHeaders.authorization = `Basic ${basic}`;
    } else {
      delete reqHeaders.authorization;
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
          fetchOnce(next, headers, redirectCount + 1, keepBasic).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
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

function rewriteTarballHosts(text) {
  return text.replace(/https?:\/\/packages\.redhat\.com/g, `http://127.0.0.1:${LISTEN_PORT}`);
}

function rewriteNpmjsHosts(text) {
  return text.replace(/https?:\/\/registry\.npmjs\.org/g, `http://127.0.0.1:${LISTEN_PORT}`);
}

/**
 * WORKAROUND (Tier B naming): map community native names to @lightwell/*.
 * Drop when recipes publish platform packages as @esbuild/* / @typescript/*.
 */
function remapNativePackageName(name) {
  let m = /^@esbuild\/(.+)$/.exec(name);
  if (m) return `@lightwell/esbuild-${m[1]}`;
  m = /^@typescript\/typescript-(.+)$/.exec(name);
  if (m) return `@lightwell/typescript-${m[1]}`;
  return name;
}

function remapDepMap(deps) {
  if (!deps || typeof deps !== 'object') return deps;
  const out = {};
  for (const [k, v] of Object.entries(deps)) {
    out[remapNativePackageName(k)] = v;
  }
  return out;
}

function keepOptionalDep(name) {
  // Drop remapped natives for other platforms — Lightwell only publishes the
  // linux-x64 variants we validate here, and other @lightwell/* names 404.
  if (name.startsWith('@lightwell/')) return /linux-x64/.test(name);
  if (name.startsWith('@esbuild/') || name.startsWith('@typescript/')) return false;
  return true;
}

function enrichVersionDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (doc.dependencies) {
    // typescript 7 puts platform packages in dependencies — remap + drop non-linux-x64
    const remapped = remapDepMap(doc.dependencies);
    const deps = {};
    for (const [k, v] of Object.entries(remapped)) {
      if (k.startsWith('@lightwell/') && !/linux-x64/.test(k)) continue;
      if (k.startsWith('@esbuild/') || (k.startsWith('@typescript/') && k.includes('typescript-'))) {
        continue;
      }
      deps[k] = v;
    }
    doc.dependencies = deps;
  }
  if (doc.optionalDependencies) {
    const remapped = remapDepMap(doc.optionalDependencies);
    const opts = {};
    for (const [k, v] of Object.entries(remapped)) {
      if (keepOptionalDep(k)) opts[k] = v;
    }
    doc.optionalDependencies = opts;
  }
  // better-sqlite3: community metadata has no Lightwell platform optional.
  if (doc.name === 'better-sqlite3' && doc.version) {
    doc.optionalDependencies = {
      ...(doc.optionalDependencies || {}),
      '@lightwell/better-sqlite3-linux-x64': doc.version,
    };
  }
  return doc;
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

async function fetchVersionDoc(packagePath, ver, hdrs) {
  const urlPath = `${packagePath.replace(/\/$/, '')}/${ver}`;
  // WORKAROUND: Pulp often has no rich /{name}/{version} doc. Prefer Lightwell,
  // then npmjs, to obtain dependency metadata missing from stub packuments.
  let out = await fetchOnce(resolveLightwell(urlPath), hdrs, 0, true);
  let from = 'lightwell';
  if (out.status === 404) {
    out = await fetchOnce(resolveNpmjs(urlPath), hdrs, 0, false);
    from = 'npmjs';
  }
  if (out.status !== 200) {
    console.error(`expand ${urlPath} status=${out.status}`);
    return null;
  }
  const raw = maybeDecode(out.body, out.headers);
  const doc = JSON.parse(raw.toString('utf8'));
  return { doc, from };
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
  // Conventional npm tarball path
  const base = name.startsWith('@') ? name : name;
  const filename = `${name.split('/').pop()}-${ver}.tgz`;
  return `/${base}/-/${filename}`;
}

async function fetchLightwellTarball(dist, name, ver, hdrs) {
  const tbPath = tarballPathFromDist(dist, name, ver);
  try {
    const out = await fetchOnce(resolveLightwell(tbPath), hdrs, 0, true);
    if (out.status !== 200) return null;
    // Keep raw bytes (already .tgz); do not gunzip.
    return { path: tbPath, body: out.body };
  } catch (_) {
    return null;
  }
}

function sriSha512(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

async function mergeNpmjsPackument(lightwellDoc, packagePath, hdrs) {
  // Lightwell content repos often list only validated versions. Merge npmjs so
  // transitive ranges like debug@2.6.9 still resolve when Lightwell only has 4.x.
  try {
    const out = await fetchOnce(resolveNpmjs(packagePath), hdrs, 0, false);
    if (out.status !== 200) return lightwellDoc;
    const npmDoc = JSON.parse(maybeDecode(out.body, out.headers).toString('utf8'));
    if (!npmDoc.versions) return lightwellDoc;
    const merged = { ...npmDoc, ...lightwellDoc };
    merged.versions = { ...npmDoc.versions };
    // Lightwell versions overlay (validated dist wins when present).
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
 * When every version is a stub, fill deps from npmjs/Lightwell version docs, keep
 * Lightwell tarball bytes, and set dist.integrity to sha512 of those bytes.
 * No-op once Pulp serves full manifests + generated integrity.
 */
async function expandStubPackument(packument, packagePath, hdrs) {
  if (!packument || typeof packument !== 'object' || !packument.versions) return packument;
  const versions = packument.versions;
  const names = Object.keys(versions);
  if (!names.length) return packument;
  const stubs = names.every((ver) => isStubVersion(versions[ver]));
  if (!stubs) return packument;

  const basePath = packagePath.replace(/\/$/, '');
  const pkgName = packument.name || basePath.replace(/^\//, '');
  await Promise.all(
    names.map(async (ver) => {
      try {
        const stub = versions[ver] || {};
        const fetched = await fetchVersionDoc(basePath, ver, hdrs);
        if (!fetched) return;
        const doc = enrichVersionDoc(fetched.doc);
        // Keep Lightwell dist when the validated tarball exists.
        // WORKAROUND: recompute integrity — Pulp stubs often omit/wrong SRI.
        const lwTb = stub.dist ? await fetchLightwellTarball(stub.dist, pkgName, ver, hdrs) : null;
        if (lwTb) {
          doc.dist = {
            ...stub.dist,
            integrity: sriSha512(lwTb.body),
            tarball: `http://127.0.0.1:${LISTEN_PORT}${lwTb.path}`,
          };
          delete doc.dist.shasum;
        }
        if (stub._id && !doc._id) doc._id = stub._id;
        versions[ver] = doc;
      } catch (err) {
        console.error(`expand ${basePath}@${ver}:`, err.message || err);
      }
    }),
  );
  return mergeNpmjsPackument(packument, basePath, hdrs);
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

    // .tgz files are already gzip; never gunzip them (npmjs often sets
    // Content-Encoding: gzip on the wire, which would double-decompress).
    const isTarball = pathOnly.endsWith('.tgz');
    let raw = isTarball ? out.body : maybeDecode(out.body, out.headers);
    let ct = out.headers['content-type'] || 'application/octet-stream';

    const looksJson =
      !isTarball &&
      ((raw.length > 0 && (raw[0] === 0x7b || raw[0] === 0x5b)) || ct.includes('json'));

    if (looksJson && out.status === 200) {
      let text = raw.toString('utf8');
      if (source === 'lightwell') {
        text = rewriteTarballHosts(text);
        try {
          let doc = JSON.parse(text);
          if (isPackumentPath(pathOnly)) {
            doc = await expandStubPackument(doc, pathOnly, hdrs);
            // Re-apply host rewrite after merge (version docs have absolute tarball URLs).
            text = rewriteTarballHosts(JSON.stringify(doc));
          } else if (doc.name && (doc.version || doc.optionalDependencies || doc.dependencies)) {
            // Single version document
            doc = enrichVersionDoc(doc);
            text = rewriteTarballHosts(JSON.stringify(doc));
          }
        } catch (err) {
          console.error(`packument rewrite failed for ${pathOnly}:`, err.message || err);
        }
      } else {
        text = rewriteNpmjsHosts(text);
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
server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`dual-registry proxy on http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`  lightwell: ${TARGET}`);
  console.log(`  npmjs:     ${UPSTREAM_NPM}`);
  console.log(`  miss log:  ${MISS_LOG}`);
});
