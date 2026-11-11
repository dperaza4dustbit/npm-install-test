#!/usr/bin/env node
/**
 * For every frozen package:
 *  1. Resolve expected .tgz sha256 from the Quay attestation subject
 *  2. Download the .tgz via the proxy (Lightwell / CDN)
 *  3. Fail clearly if CDN/proxy bytes do not match the attestation (stale replace)
 *  4. Hard-fail if package/sboms/redhat.spdx.json is missing / inaccurate
 *  5. Verify DSSE with Red Hat release key 3
 *
 * Pubkey: keys/redhat-release3.pub (same customer key as Python RHTL /
 * https://security.access.redhat.com/data/63405576.txt). Verification mirrors
 * redhat-tssc-tmm/trusted-libraries (DSSE PAE + cosign verify-blob).
 *
 * PROVENANCE_FALLBACK_QUAY=1 — if proxy/CDN stays stale after retries, pull the
 * .tgz from the Quay `:name-version.npm` artifact instead (still verifies SBOM
 * + attestation; does not exercise the customer registry path).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT,
  loadInventory,
  run,
  assert,
  sha256File,
  attestationOciTag,
  npmArtifactOciTag,
  createDssePae,
  npmrcForProxy,
} from './lib.mjs';

const PROXY = process.env.NPM_PROXY_URL || 'http://127.0.0.1:4874';
const inv = loadInventory();
const KEY = path.join(ROOT, inv.cosign_public_key);
const SBOM_MEMBER = inv.sbom_path_in_tarball;
const ATT_PREFIX = process.env.ATTESTATION_OCI_PREFIX || inv.attestation_oci_prefix;
const only = process.env.ONLY_PACKAGE;
const FALLBACK_QUAY = process.env.PROVENANCE_FALLBACK_QUAY === '1';
const DOWNLOAD_ATTEMPTS = Math.max(1, Number(process.env.PROVENANCE_CDN_RETRIES || 3));

assert(fs.existsSync(KEY), `missing cosign public key: ${KEY}`);

function encodePackagePath(name) {
  if (name.startsWith('@')) {
    const [scope, pkg] = name.slice(1).split('/');
    return `@${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
  }
  return encodeURIComponent(name);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

function sleepMs(ms) {
  run('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))]);
}

function pullAttestationSubjects(name, version, workDir) {
  const tag = attestationOciTag(name, version);
  const ref = `${ATT_PREFIX}:${tag}`;
  const attDir = path.join(workDir, 'att');
  fs.mkdirSync(attDir, { recursive: true });
  run('oras', ['pull', ref, '-o', attDir], { env: { ...process.env } });

  const attFiles = fs.readdirSync(attDir).filter((f) => f.endsWith('.att') || f.endsWith('.json'));
  assert(attFiles.length > 0, `${name}@${version}: oras pull ${ref} produced no .att`);
  const attPath = path.join(attDir, attFiles.find((f) => f.endsWith('.att')) || attFiles[0]);
  const att = JSON.parse(fs.readFileSync(attPath, 'utf8'));

  const payloadB64 = att.payload || att.envelope?.payload;
  const sigB64 = att.signatures?.[0]?.sig || att.envelope?.signatures?.[0]?.sig;
  assert(
    payloadB64 && sigB64,
    `${name}@${version}: attestation is not a cosign-signed DSSE envelope (need payload + signatures)`,
  );

  const statement = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  const subjects = statement.subject || statement.subjects || [];
  const digests = subjects.map((s) => s.digest?.sha256).filter(Boolean);
  assert(digests.length > 0, `${name}@${version}: attestation has no subject sha256`);
  return { ref, tag, attPath, payloadB64, sigB64, digests, att };
}

async function downloadTarballViaProxy(name, version, dest) {
  const meta = await fetchJson(`${PROXY}/${encodePackagePath(name)}`);
  const ver = meta.versions?.[version];
  assert(ver, `version ${version} not in registry metadata for ${name}`);
  const tarball = ver.dist?.tarball;
  const integrity = ver.dist?.integrity;
  assert(tarball, `no dist.tarball for ${name}@${version}`);
  // Cache-bust on the proxy hop too (proxy rewrites host; query reaches proxy).
  const bust = `${tarball}${tarball.includes('?') ? '&' : '?'}_harness_cb=${Date.now()}`;
  const res = await fetch(bust, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  assert(res.ok, `tarball fetch failed ${tarball}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { integrity, sha256: sha256File(dest), bytes: buf.length, source: 'proxy' };
}

function downloadTarballViaQuay(name, version, dest, workDir) {
  const tag = npmArtifactOciTag(name, version);
  const ref = `${ATT_PREFIX}:${tag}`;
  const out = path.join(workDir, 'npm-oci');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  run('oras', ['pull', ref, '-o', out], { env: { ...process.env } });
  const tgz = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
  assert(tgz, `${name}@${version}: oras pull ${ref} produced no .tgz`);
  fs.copyFileSync(path.join(out, tgz), dest);
  return { integrity: null, sha256: sha256File(dest), bytes: fs.statSync(dest).size, source: `quay:${ref}` };
}

async function downloadMatchingTarball(name, version, dest, expectedDigests, workDir) {
  let last = null;
  for (let i = 1; i <= DOWNLOAD_ATTEMPTS; i++) {
    last = await downloadTarballViaProxy(name, version, dest);
    if (expectedDigests.includes(last.sha256)) return last;
    console.warn(
      `  CDN/proxy digest mismatch attempt ${i}/${DOWNLOAD_ATTEMPTS}: got ${last.sha256} want ${expectedDigests.join('|')} (${last.bytes} bytes)`,
    );
    if (i < DOWNLOAD_ATTEMPTS) sleepMs(1500 * i);
  }
  if (FALLBACK_QUAY) {
    console.warn(`  PROVENANCE_FALLBACK_QUAY=1 — pulling released .tgz from Quay .npm artifact`);
    const quay = downloadTarballViaQuay(name, version, dest, workDir);
    assert(
      expectedDigests.includes(quay.sha256),
      `${name}@${version}: Quay .npm sha256 ${quay.sha256} also mismatches attestation ${expectedDigests.join('|')}`,
    );
    return quay;
  }
  throw new Error(
    `${name}@${version}: CDN/proxy returned stale tarball after ${DOWNLOAD_ATTEMPTS} tries ` +
      `(got sha256=${last.sha256} bytes=${last.bytes}; attestation wants ${expectedDigests.join('|')}). ` +
      `packages.redhat.com can lag after ALLOW_CONTENT_REPLACE. Retry later, or set PROVENANCE_FALLBACK_QUAY=1 ` +
      `to verify SBOM/attestation from the Quay .npm artifact.`,
  );
}

function listTarballMembers(tgz) {
  const res = run('tar', ['tzf', tgz]);
  return res.stdout.split('\n').filter(Boolean);
}

function extractMemberBinary(tgz, member, dest) {
  const res = run('tar', ['-xOf', tgz, member], { encoding: 'buffer' });
  fs.writeFileSync(dest, res.stdout);
}

function verifySbom(name, version, tgz, members) {
  assert(members.includes(SBOM_MEMBER), `${name}@${version}: missing ${SBOM_MEMBER}`);
  const tmp = path.join(os.tmpdir(), `sbom-${name.replace(/[/]/g, '_')}-${version}.json`);
  extractMemberBinary(tgz, SBOM_MEMBER, tmp);
  const sbom = JSON.parse(fs.readFileSync(tmp, 'utf8'));

  assert(
    typeof sbom.spdxVersion === 'string' && sbom.spdxVersion.startsWith('SPDX-2'),
    `${name}@${version}: SBOM is not SPDX-2.x JSON`,
  );
  const pkgs = sbom.packages || [];
  assert(pkgs.length > 0, `${name}@${version}: SBOM has no packages[]`);

  // Require enriched npm identity (purl and/or name+version) in the SBOM.
  // Spec: pkg:npm/%40scope/name@version. Also accept legacy unencoded
  // pkg:npm/@scope/name@version from older tarballs.
  const purlHits = pkgs.filter((p) => {
    const refs = p.externalRefs || [];
    const needles = name.startsWith('@')
      ? [`pkg:npm/%40${name.slice(1)}@`, `pkg:npm/${name}@`]
      : [`pkg:npm/${name}@`];
    return refs.some(
      (r) =>
        typeof r.referenceLocator === 'string' &&
        needles.some((needle) => r.referenceLocator.includes(needle)),
    );
  });
  const nameHits = pkgs.filter(
    (p) => p.name === name || p.name === `package/${name}` || (p.name || '').endsWith(`/${name}`),
  );
  const versionHits = [...purlHits, ...nameHits].filter((p) => (p.versionInfo || p.version) === version);
  assert(
    versionHits.length > 0,
    `${name}@${version}: SBOM missing npm identity (expected purl and/or name+version ${name}@${version})`,
  );

  // File inventory overlap when SPDX has files
  const files = sbom.files || [];
  if (files.length > 0) {
    const memberSet = new Set(members.map((m) => m.replace(/^package\//, '')));
    let checked = 0;
    for (const f of files.slice(0, 50)) {
      const fn = (f.fileName || '').replace(/^\.\//, '').replace(/^package\//, '');
      if (!fn || fn === 'sboms/redhat.spdx.json') continue;
      const base = path.posix.basename(fn);
      const present =
        memberSet.has(fn) || members.some((m) => m === `package/${fn}` || m.endsWith(`/${base}`));
      assert(present, `${name}@${version}: SBOM file not in tarball: ${fn}`);
      checked += 1;
      if (checked >= 10) break;
    }
  }
  return { packageCount: pkgs.length, fileCount: files.length, identityInSbom: true };
}

function verifyAttestationSignature(name, version, tgzSha256, attInfo) {
  const { ref, attPath, payloadB64, sigB64, digests } = attInfo;
  assert(
    digests.includes(tgzSha256),
    `${name}@${version}: attestation subject sha256 mismatch (want ${tgzSha256}, got ${digests.join(',') || 'none'})`,
  );

  const attDir = path.dirname(attPath);
  const payload = Buffer.from(payloadB64, 'base64');
  const pae = createDssePae(payload, 'application/vnd.in-toto+json');
  const paePath = path.join(attDir, 'pae.bin');
  const sigPath = path.join(attDir, 'sig.bin');
  fs.writeFileSync(paePath, pae);
  fs.writeFileSync(sigPath, Buffer.from(sigB64, 'base64'));
  run(
    'cosign',
    ['verify-blob', '--key', KEY, '--signature', sigPath, '--insecure-ignore-tlog=true', paePath],
    { env: { ...process.env } },
  );
  return { ref, signed: true };
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-provenance-'));
fs.writeFileSync(path.join(workRoot, '.npmrc'), npmrcForProxy(PROXY));

let failed = 0;
const results = [];

for (const pkg of inv.packages) {
  if (only && pkg.name !== only && `${pkg.name}@${pkg.version}` !== only) continue;
  const label = `${pkg.name}@${pkg.version}`;
  const safe = label.replace(/[/]/g, '__');
  const dir = path.join(workRoot, safe);
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, 'pkg.tgz');
  process.chdir(dir);
  try {
    console.log(`\n[provenance] ${label}`);
    const attInfo = pullAttestationSubjects(pkg.name, pkg.version, dir);
    console.log(`  attestation subjects sha256=${attInfo.digests.join(',')}`);
    const dl = await downloadMatchingTarball(pkg.name, pkg.version, tgz, attInfo.digests, dir);
    console.log(`  tarball sha256=${dl.sha256} bytes=${dl.bytes} source=${dl.source}`);
    const members = listTarballMembers(tgz);
    const sbom = verifySbom(pkg.name, pkg.version, tgz, members);
    console.log(`  SBOM ok (packages=${sbom.packageCount} files=${sbom.fileCount})`);
    const att = verifyAttestationSignature(pkg.name, pkg.version, dl.sha256, attInfo);
    console.log(`  attestation ok (${att.ref}, DSSE)`);
    results.push({ label, ok: true, signed: true, source: dl.source });
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${label}: ${err.message || err}`);
    results.push({ label, ok: false, signed: false, error: String(err.message || err) });
  }
}

const passed = results.filter((r) => r.ok).length;

console.log('\n[provenance] per-package');
for (const r of results) {
  const tag = r.ok ? 'OK  ' : 'FAIL';
  const extra = r.error ? ` — ${r.error}` : r.source && r.source !== 'proxy' ? ` (${r.source})` : '';
  console.log(`  ${tag} ${r.label}${extra}`);
}

console.log('\n========== PROVENANCE SUMMARY ==========');
console.log(`  packages passed:     ${passed}`);
console.log(`  packages failed:     ${failed}`);
console.log(`  packages total:      ${results.length}`);
console.log(`  attestations signed: ${passed} (DSSE)`);
console.log('========================================');
if (failed) {
  console.error(`[provenance] FAIL (${failed} package(s))`);
  process.exit(1);
}
console.log('[provenance] OK');
