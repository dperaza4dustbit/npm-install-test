#!/usr/bin/env node
/**
 * Install every frozen package version (via npm aliases) through the local proxy.
 * Fails if any dependency cannot be resolved. Prints proxy miss summary.
 *
 * Aliases are generated from inventory/packages.json (not a hand-edited fixture)
 * so new inventory entries cannot drift out of install-all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadInventory, runWithRetries, npmrcForProxy } from './lib.mjs';

const PROXY = process.env.NPM_PROXY_URL || 'http://127.0.0.1:4874';
const MISS_LOG = process.env.PROXY_MISS_LOG || '/tmp/npm-proxy-misses.jsonl';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-install-all-'));
const inv = loadInventory();

function aliasName(name, version) {
  // npm rejects alias names that start with "_"; strip "@scope/" to "scope_"
  // so @lightwell/foo@1.0.0 → lightwell_foo_1_0_0 (same as fixture/).
  return `${name}_${version}`
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_]/g, '_');
}

const dependencies = {};
for (const p of inv.packages) {
  dependencies[aliasName(p.name, p.version)] = `npm:${p.name}@${p.version}`;
}

fs.writeFileSync(
  path.join(work, 'package.json'),
  `${JSON.stringify(
    {
      name: 'npm-install-test-fixture',
      version: '0.0.0',
      private: true,
      description: 'Generated from inventory/packages.json for install-all',
      dependencies,
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(path.join(work, '.npmrc'), npmrcForProxy(PROXY, path.join(work, '.npm-cache')));

console.log(`[install-all] workdir=${work}`);
console.log(`[install-all] proxy=${PROXY}`);
console.log(`[install-all] node=${process.version}`);
console.log(`[install-all] aliases=${Object.keys(dependencies).length}`);

runWithRetries('npm', ['install', '--no-audit', '--no-fund', '--foreground-scripts'], {
  cwd: work,
  env: { ...process.env, npm_config_registry: PROXY },
});

for (const p of inv.packages) {
  const alias = aliasName(p.name, p.version);
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
