#!/usr/bin/env node
/**
 * Packument completeness checks via the dual-registry proxy.
 *
 * Does **not** npm install. For each inventory package it GETs the Lightwell
 * **packument** (`GET /name`) and inspects `versions[version]` — the document
 * npm install uses. `/name/version` is intentionally ignored: Pulp can serve a
 * full version doc there while packument entries are still stubs.
 *
 * Pass = packument version entry is complete (not a pulp_npm stub) and matches
 * the Lightwell `.tgz` (`dependencies` / `optionalDependencies` /
 * `peerDependencies` + `dist.integrity`).
 * Fail = missing packument data (stub / absent version / integrity or deps
 * mismatch vs the published tarball).
 *
 * Platform packages (`kind: platform`) are skipped; parents + binaries cover them.
 *
 *   ONLY_PACKAGE=debug@2.6.9 ./scripts/run.sh packuments
 *   PACKUMENT_COMPARE_NPMJS=1  # optional secondary compare to community npmjs
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  loadInventory,
  assert,
} from './lib.mjs';

const PROXY = (process.env.NPM_PROXY_URL || 'http://127.0.0.1:8081/repository/npm-group').replace(/\/$/, '');
const UPSTREAM = (process.env.UPSTREAM_REGISTRY_URL || 'https://registry.npmjs.org').replace(
  /\/$/,
  '',
);
const only = process.env.ONLY_PACKAGE;
const COMPARE_NPMJS = process.env.PACKUMENT_COMPARE_NPMJS === '1';

const STUB_KEYS = new Set(['_id', 'dist', 'name', 'version']);
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function encodePackagePath(name) {
  if (name.startsWith('@')) {
    const [scope, pkg] = name.slice(1).split('/');
    return `@${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
  }
  return encodeURIComponent(name);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'npm-install-test-packuments' },
  });
  if (!res.ok) {
    const err = new Error(`GET ${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { accept: '*/*', 'user-agent': 'npm-install-test-packuments' },
  });
  if (!res.ok) {
    const err = new Error(`GET ${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

function isStubVersion(doc) {
  if (!doc || typeof doc !== 'object') return true;
  return Object.keys(doc).every((k) => STUB_KEYS.has(k));
}

function depMap(doc, field) {
  const v = doc?.[field];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v;
}

function sameDepMaps(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (String(a[ak[i]]) !== String(b[bk[i]])) return false;
  }
  return true;
}

function sriSha512(buf) {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

/** Read one member from an npm .tgz (gzip+ustar) without writing to disk. */
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
  assert(raw, 'package/package.json missing from tarball');
  return JSON.parse(raw.toString('utf8'));
}

function tarballUrlFromDist(dist, name, version) {
  if (dist?.tarball) {
    try {
      const u = new URL(dist.tarball);
      const proxy = new URL(PROXY);
      const proxyPath = proxy.pathname.replace(/\/$/, '') || '';
      // Nexus group tarballs already include /repository/<group>/... in pathname.
      // Custom/Verdaccio-style registries usually only have /<name>/-/<file>.tgz.
      if (proxyPath && (u.pathname === proxyPath || u.pathname.startsWith(`${proxyPath}/`))) {
        return `${proxy.origin}${u.pathname}${u.search}`;
      }
      // Rewrite host onto the manager; keep the registry-relative pathname.
      return `${PROXY}${u.pathname}${u.search}`;
    } catch (_) {
      /* fall through */
    }
  }
  const filename = `${name.split('/').pop()}-${version}.tgz`;
  return `${PROXY}/${encodePackagePath(name)}/-/${filename}`;
}

/**
 * Version doc npm install resolves from: packument versions[version].
 * Do not use GET /name/version — that can be complete while the packument is not.
 */
async function lightwellPackumentVersionDoc(name, version) {
  const packument = await fetchJson(`${PROXY}/${encodePackagePath(name)}`);
  const doc = packument?.versions?.[version];
  assert(doc, `${name}@${version}: missing from Lightwell packument versions[]`);
  return doc;
}

async function npmjsVersionDoc(name, version) {
  const base = `${UPSTREAM}/${encodePackagePath(name)}`;
  try {
    return await fetchJson(`${base}/${encodeURIComponent(version)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const packument = await fetchJson(base);
  return packument?.versions?.[version] || null;
}

const inv = loadInventory();
let failed = 0;
let ran = 0;
let skipped = 0;

console.log('\n[packuments] per-package (packument versions[] vs Lightwell .tgz)');

for (const pkg of inv.packages) {
  if (only && pkg.name !== only && `${pkg.name}@${pkg.version}` !== only) continue;
  const label = `${pkg.name}@${pkg.version}`;

  if (pkg.kind === 'platform') {
    skipped += 1;
    console.log(`  SKIP ${label} (platform package)`);
    continue;
  }

  try {
    const lw = await lightwellPackumentVersionDoc(pkg.name, pkg.version);
    assert(
      !isStubVersion(lw),
      `${label}: packument versions[] is a stub (only ${Object.keys(lw).join(',')}); ` +
        `npm install will not see dependencies (GET /${pkg.name}/${pkg.version} may still look complete)`,
    );
    assert(lw.name === pkg.name || lw.name == null, `${label}: unexpected name ${lw.name}`);
    assert(lw.version === pkg.version || lw.version == null, `${label}: unexpected version ${lw.version}`);
    assert(lw.dist && typeof lw.dist === 'object', `${label}: missing dist`);
    assert(typeof lw.dist.tarball === 'string' && lw.dist.tarball.length > 0, `${label}: missing dist.tarball`);
    assert(
      typeof lw.dist.integrity === 'string' && lw.dist.integrity.startsWith('sha512-'),
      `${label}: missing/invalid dist.integrity`,
    );

    const tgz = await fetchBuffer(tarballUrlFromDist(lw.dist, pkg.name, pkg.version));
    const wantIntegrity = sriSha512(tgz);
    assert(
      lw.dist.integrity === wantIntegrity,
      `${label}: dist.integrity does not match Lightwell .tgz bytes\n` +
        `  packument: ${lw.dist.integrity}\n  tarball:   ${wantIntegrity}`,
    );

    const packed = packageJsonFromTarball(tgz);
    for (const field of DEP_FIELDS) {
      const want = depMap(packed, field);
      const got = depMap(lw, field);
      assert(
        sameDepMaps(want, got),
        `${label}: packument ${field} mismatch vs tarball package.json\n` +
          `  tarball:   ${JSON.stringify(want)}\n` +
          `  packument: ${JSON.stringify(got)}`,
      );
    }

    if (COMPARE_NPMJS) {
      const npm = await npmjsVersionDoc(pkg.name, pkg.version);
      if (npm) {
        for (const field of DEP_FIELDS) {
          const want = depMap(npm, field);
          const got = depMap(lw, field);
          if (Object.keys(want).length === 0) continue;
          assert(
            sameDepMaps(want, got),
            `${label}: ${field} mismatch vs npmjs\n  npmjs: ${JSON.stringify(want)}\n  lightwell: ${JSON.stringify(got)}`,
          );
        }
      } else {
        console.warn(`  ! ${label}: no npmjs version to compare (skipped dep map check)`);
      }
    }

    ran += 1;
    console.log(`  OK ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${label}: ${err && err.message ? err.message : err}`);
  }
}

console.log('\n========== PACKAGES SUMMARY ==========');
console.log(`  packages passed:  ${ran}`);
console.log(`  packages failed:  ${failed}`);
console.log(`  packages skipped: ${skipped}`);
console.log(`  packages total:   ${ran + failed + skipped}`);
console.log('========================================');
if (failed) {
  console.error(`[packuments] FAIL (${failed} package(s) incomplete/missing packument data)`);
  process.exit(1);
}
console.log('[packuments] OK');
