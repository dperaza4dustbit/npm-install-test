#!/usr/bin/env node
/**
 * Install every frozen package version (via npm aliases) through the local proxy.
 * Fails if any dependency cannot be resolved. Prints proxy miss summary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadInventory, runWithRetries, npmrcForProxy } from './lib.mjs';

const PROXY = process.env.NPM_PROXY_URL || 'http://127.0.0.1:4874';
const MISS_LOG = process.env.PROXY_MISS_LOG || '/tmp/npm-proxy-misses.jsonl';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-install-all-'));

const fixtureSrc = path.join(ROOT, 'fixture/package.json');
fs.copyFileSync(fixtureSrc, path.join(work, 'package.json'));
fs.writeFileSync(path.join(work, '.npmrc'), npmrcForProxy(PROXY, path.join(work, '.npm-cache')));

console.log(`[install-all] workdir=${work}`);
console.log(`[install-all] proxy=${PROXY}`);
console.log(`[install-all] node=${process.version}`);

runWithRetries('npm', ['install', '--no-audit', '--no-fund', '--foreground-scripts'], {
  cwd: work,
  env: { ...process.env, npm_config_registry: PROXY },
});

const inv = loadInventory();
const parents = inv.packages.filter((p) => p.kind === 'package');
for (const p of parents) {
  const alias = `${p.name}_${p.version}`.replace(/[^A-Za-z0-9_]/g, '_');
  const modPath = path.join(work, 'node_modules', alias);
  if (!fs.existsSync(modPath)) {
    throw new Error(`missing installed alias module: ${alias} (${p.name}@${p.version})`);
  }
}

if (fs.existsSync(MISS_LOG)) {
  const lines = fs.readFileSync(MISS_LOG, 'utf8').trim().split('\n').filter(Boolean);
  console.log(`[install-all] proxy npmjs fallback misses: ${lines.length}`);
  for (const line of lines.slice(0, 40)) console.log(`  MISS ${line}`);
  if (lines.length > 40) console.log(`  ... ${lines.length - 40} more`);
} else {
  console.log('[install-all] no miss log found');
}

console.log('[install-all] OK');
console.log(work);
