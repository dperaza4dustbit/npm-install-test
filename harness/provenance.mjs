#!/usr/bin/env node
/**
 * For every frozen package:
 *  1. Download the .tgz via the proxy (Lightwell)
 *  2. Hard-fail if package/sboms/redhat.spdx.json is missing / inaccurate
 *  3. Pull attestation OCI, verify DSSE with Red Hat release key 3, match subject digest
 *
 * Pubkey: keys/redhat-release3.pub (same customer key as Python RHTL /
 * https://security.access.redhat.com/data/63405576.txt). Verification mirrors
 * redhat-tssc-tmm/trusted-libraries (DSSE PAE + cosign verify-blob).
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
  createDssePae,
  npmrcForProxy,
} from './lib.mjs';

const PROXY = process.env.NPM_PROXY_URL || 'http://127.0.0.1:4874';
const inv = loadInventory();
const KEY = path.join(ROOT, inv.cosign_public_key);
const SBOM_MEMBER = inv.sbom_path_in_tarball;
const ATT_PREFIX = process.env.ATTESTATION_OCI_PREFIX || inv.attestation_oci_prefix;

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

async function downloadTarball(name, version, dest) {
  const meta = await fetchJson(`${PROXY}/${encodePackagePath(name)}`);
  const ver = meta.versions?.[version];
  assert(ver, `version ${version} not in registry metadata for ${name}`);
  const tarball = ver.dist?.tarball;
  const integrity = ver.dist?.integrity;
  assert(tarball, `no dist.tarball for ${name}@${version}`);
  const res = await fetch(tarball);
  assert(res.ok, `tarball fetch failed ${tarball}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { integrity, sha256: sha256File(dest), bytes: buf.length };
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

  // Prefer npm purl / name+version when Syft recorded them. Many Lightwell
  // tarballs currently ship directory-root Syft SBOMs (path-only names) — those
  // still count as present once SPDX shape is valid; identity then comes from
  // package/package.json in the same tarball.
  const purlHits = pkgs.filter((p) => {
    const refs = p.externalRefs || [];
    // Spec: pkg:npm/%40scope/name@version. Also accept legacy unencoded
    // pkg:npm/@scope/name@version from tarballs published before encoding.
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
  const identityInSbom = versionHits.length > 0;

  if (!identityInSbom) {
    const pkgJsonMember =
      members.find((m) => m === 'package/package.json') ||
      members.find((m) => /^[^/]+\/package\.json$/.test(m));
    assert(pkgJsonMember, `${name}@${version}: SBOM lacks npm identity and tarball has no package.json`);
    const pkgJsonPath = path.join(os.tmpdir(), `pkgjson-${name.replace(/[/]/g, '_')}-${version}.json`);
    extractMemberBinary(tgz, pkgJsonMember, pkgJsonPath);
    const meta = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    assert(meta.name === name, `${name}@${version}: package.json name mismatch (${meta.name})`);
    assert(String(meta.version) === version, `${name}@${version}: package.json version mismatch (${meta.version})`);
  }

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
  return { packageCount: pkgs.length, fileCount: files.length, identityInSbom };
}

function verifyAttestation(name, version, tgzSha256, workDir) {
  const tag = attestationOciTag(name, version);
  const ref = `${ATT_PREFIX}:${tag}`;
  const attDir = path.join(workDir, 'att');
  fs.mkdirSync(attDir, { recursive: true });
  const allowUnsigned = process.env.PROVENANCE_ALLOW_UNSIGNED === '1';

  run('oras', ['pull', ref, '-o', attDir], { env: { ...process.env } });

  const attFiles = fs.readdirSync(attDir).filter((f) => f.endsWith('.att') || f.endsWith('.json'));
  assert(attFiles.length > 0, `${name}@${version}: oras pull ${ref} produced no .att`);
  const attPath = path.join(attDir, attFiles.find((f) => f.endsWith('.att')) || attFiles[0]);
  const att = JSON.parse(fs.readFileSync(attPath, 'utf8'));

  // Lightwell currently publishes a bare in-toto Statement in the .att layer
  // (artifactType claims DSSE, but the blob is the statement). Prefer DSSE when present.
  const payloadB64 = att.payload || att.envelope?.payload;
  const sigB64 = att.signatures?.[0]?.sig || att.envelope?.signatures?.[0]?.sig;
  const isDsse = Boolean(payloadB64 && sigB64);
  const isStatement = typeof att._type === 'string' && att._type.includes('Statement');

  let statement;
  if (isDsse) {
    statement = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  } else if (isStatement) {
    statement = att;
  } else {
    throw new Error(`${name}@${version}: unrecognized attestation shape (need DSSE or in-toto Statement)`);
  }

  const subjects = statement.subject || statement.subjects || [];
  const digests = subjects.map((s) => s.digest?.sha256).filter(Boolean);
  assert(
    digests.includes(tgzSha256),
    `${name}@${version}: attestation subject sha256 mismatch (want ${tgzSha256}, got ${digests.join(',') || 'none'})`,
  );

  if (isDsse) {
    const payload = Buffer.from(payloadB64, 'base64');
    const pae = createDssePae(payload, att.payloadType || 'application/vnd.in-toto+json');
    const paePath = path.join(attDir, 'pae.bin');
    const sigPath = path.join(attDir, 'sig.bin');
    fs.writeFileSync(paePath, pae);
    fs.writeFileSync(sigPath, Buffer.from(sigB64, 'base64'));
    run(
      'cosign',
      ['verify-blob', '--key', KEY, '--signature', sigPath, '--insecure-ignore-tlog=true', paePath],
      { env: { ...process.env } },
    );
    return { ref, tag, signed: true };
  }

  if (!allowUnsigned) {
    throw new Error(
      `${name}@${version}: attestation subject matches tarball, but .att is an unsigned in-toto Statement (no DSSE). Set PROVENANCE_ALLOW_UNSIGNED=1 to accept subject-only checks until Lightwell publishes cosign-signed DSSE.`,
    );
  }
  console.log('  WARN attestation unsigned (subject digest OK; PROVENANCE_ALLOW_UNSIGNED=1)');
  return { ref, tag, signed: false };
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-provenance-'));
fs.writeFileSync(path.join(workRoot, '.npmrc'), npmrcForProxy(PROXY));

let failed = 0;
const results = [];

for (const pkg of inv.packages) {
  const label = `${pkg.name}@${pkg.version}`;
  const safe = label.replace(/[/]/g, '__');
  const dir = path.join(workRoot, safe);
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, 'pkg.tgz');
  process.chdir(dir);
  try {
    console.log(`\n[provenance] ${label}`);
    const dl = await downloadTarball(pkg.name, pkg.version, tgz);
    console.log(`  tarball sha256=${dl.sha256} bytes=${dl.bytes}`);
    const members = listTarballMembers(tgz);
    const sbom = verifySbom(pkg.name, pkg.version, tgz, members);
    console.log(`  SBOM ok (packages=${sbom.packageCount} files=${sbom.fileCount})`);
    const att = verifyAttestation(pkg.name, pkg.version, dl.sha256, dir);
    console.log(`  attestation ok (${att.ref}${att.signed ? '' : ', unsigned'})`);
    results.push({ label, ok: true, signed: Boolean(att.signed) });
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${label}: ${err.message || err}`);
    results.push({ label, ok: false, signed: false, error: String(err.message || err) });
  }
}

const passed = results.filter((r) => r.ok).length;
const signed = results.filter((r) => r.ok && r.signed).length;
const unsigned = results.filter((r) => r.ok && !r.signed).length;

console.log('\n[provenance] per-package');
for (const r of results) {
  const tag = !r.ok ? 'FAIL' : r.signed ? 'OK  ' : 'OK* ';
  console.log(`  ${tag} ${r.label}${r.error ? ' — ' + r.error : !r.ok ? '' : r.signed ? '' : ' (unsigned Statement)'}`);
}

console.log('\n========== PROVENANCE SUMMARY ==========');
console.log(`  packages passed:     ${passed}`);
console.log(`  packages failed:     ${failed}`);
console.log(`  packages total:      ${results.length}`);
console.log(`  attestations signed: ${signed} (DSSE)`);
console.log(`  attestations unsigned: ${unsigned} (subject OK; ALLOW_UNSIGNED)`);
console.log('========================================');
if (failed) {
  console.error(`[provenance] FAIL (${failed} package(s))`);
  process.exit(1);
}
console.log('[provenance] OK');

