import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export function loadInventory() {
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'inventory/packages.json'), 'utf8'));
  return inv;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(
      `${cmd} ${args.join(' ')} failed (${res.status}):\n${res.stdout || ''}\n${res.stderr || ''}`,
    );
    err.status = res.status;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return res;
}

/** Retry on transient Verdaccio/Pulp uplink errors (401/500 during tarball fetch). */
export function runWithRetries(cmd, args, opts = {}, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return run(cmd, args, opts);
    } catch (err) {
      last = err;
      const text = `${err.stderr || ''}\n${err.stdout || ''}\n${err.message || ''}`;
      const retryable = /E500|E401|ECONNRESET|ETIMEDOUT|bad uplink status|socket hang up/i.test(text);
      if (!retryable || i === attempts) throw err;
      const delayMs = 1000 * i;
      console.warn(`[retry] ${cmd} ${args[0] || ''} attempt ${i}/${attempts} failed; sleep ${delayMs}ms`);
      spawnSync('sleep', [String(i)], { encoding: 'utf8' });
    }
  }
  throw last;
}

export function attestationOciTag(name, version) {
  let raw;
  if (name.startsWith('@')) {
    raw = `${name.slice(1).replace(/\//g, '--')}-${version}-att`;
  } else {
    raw = `${name}-${version}-att`;
  }
  let sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!/^[A-Za-z0-9_]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (sanitized.length > 128) sanitized = sanitized.slice(0, 128);
  return sanitized;
}

export function createDssePae(payloadBytes, payloadType = 'application/vnd.in-toto+json') {
  const typeBuf = Buffer.from(payloadType, 'utf8');
  const parts = [
    Buffer.from('DSSEv1 ', 'utf8'),
    Buffer.from(String(typeBuf.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    typeBuf,
    Buffer.from(' ', 'utf8'),
    Buffer.from(String(payloadBytes.length), 'utf8'),
    Buffer.from(' ', 'utf8'),
    payloadBytes,
  ];
  return Buffer.concat(parts);
}

export function npmrcForProxy(proxyUrl, cacheDir) {
  return [
    `registry=${proxyUrl}`,
    `always-auth=false`,
    `fetch-retries=2`,
    `fetch-retry-mintimeout=2000`,
    `fetch-retry-maxtimeout=10000`,
    cacheDir ? `cache=${cacheDir}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse inventory platform_package "name@version" (scoped names allowed).
 * @returns {{ name: string, version: string }}
 */
export function parsePlatformPackage(spec) {
  if (!spec) throw new Error('empty platform_package');
  const at = spec.lastIndexOf('@');
  if (at <= 0) throw new Error(`invalid platform_package: ${spec}`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Community package name that unpatched JS still require()s for a Lightwell
 * platform package (esbuild / typescript native loaders).
 */
export function communityNativeAlias(lightwellName) {
  let m = /^@lightwell\/esbuild-(.+)$/.exec(lightwellName);
  if (m) return `@esbuild/${m[1]}`;
  m = /^@lightwell\/typescript-(.+)$/.exec(lightwellName);
  if (m) return `@typescript/typescript-${m[1]}`;
  return null;
}

/**
 * Dependencies for installing a parent package so @lightwell platform binaries
 * resolve, including npm aliases for community require() paths.
 */
export function installDepsForPackage(pkg) {
  const deps = { [pkg.name]: pkg.version };
  if (pkg.name === 'react-dom') deps.react = pkg.version;
  if (pkg.platform_package) {
    const plat = parsePlatformPackage(pkg.platform_package);
    deps[plat.name] = plat.version;
    const community = communityNativeAlias(plat.name);
    if (community) deps[community] = `npm:${plat.name}@${plat.version}`;
  }
  return deps;
}

/** Absolute path to the Node major binary installed in the harness image. */
export function nodeBinForMajor(major) {
  const m = Number(major) || 22;
  const candidate = `/usr/local/lib/nodejs/node${m}/bin/node`;
  if (fs.existsSync(candidate)) return candidate;
  return process.execPath;
}

export function npmBinForMajor(major) {
  const m = Number(major) || 22;
  const candidate = `/usr/local/lib/nodejs/node${m}/bin/npm`;
  if (fs.existsSync(candidate)) return candidate;
  return 'npm';
}

export function pathForNodeMajor(major) {
  const m = Number(major) || 22;
  const bin = `/usr/local/lib/nodejs/node${m}/bin`;
  return fs.existsSync(bin) ? `${bin}:${process.env.PATH || ''}` : process.env.PATH;
}
