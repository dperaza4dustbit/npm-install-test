#!/usr/bin/env node
/**
 * Install each frozen *parent* package version and run five smoke tests.
 *
 * @lightwell/* platform packages are not given their own 5-smoke suites:
 * installing a Tier B/C parent pulls them via optionalDependencies, and the
 * parent suite (plus harness/check-binaries.mjs) asserts they load/run.
 * Platform entries remain in inventory for provenance verification.
 *
 * Packages with node_major different from the current process are re-exec'd
 * under that Node (native ABI must match the @lightwell prebuild).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  loadInventory,
  run,
  runWithRetries,
  npmrcForProxy,
  installDepsForPackage,
  nodeBinForMajor,
  pathForNodeMajor,
} from './lib.mjs';
import { suites } from '../tests/functional/suites.mjs';

const PROXY = process.env.NPM_PROXY_URL || 'http://127.0.0.1:4874';
const inv = loadInventory();
const only = process.env.ONLY_PACKAGE; // optional name filter
const self = fileURLToPath(import.meta.url);
const currentMajor = Number(process.versions.node.split('.')[0]);

async function loadModule(dir, name, esm) {
  const req = createRequire(path.join(dir, 'package.json'));
  if (esm) {
    const resolved = req.resolve(name);
    return import(pathToFileURL(resolved).href);
  }
  return req(name);
}

let failed = 0;
let ran = 0;

for (const pkg of inv.packages) {
  if (pkg.kind === 'platform') continue;
  if (only && pkg.name !== only && `${pkg.name}@${pkg.version}` !== only) continue;
  const label = `${pkg.name}@${pkg.version}`;
  const wantMajor = Number(pkg.node_major) || 22;

  // Native ABI packages: run this one package under the matching Node binary.
  if (wantMajor !== currentMajor && !process.env.NPM_INSTALL_TEST_NODE_PINNED) {
    console.log(`\n[functional] ${label} (Node ${wantMajor})`);
    try {
      const nodeBin = nodeBinForMajor(wantMajor);
      run(nodeBin, [self], {
        env: {
          ...process.env,
          ONLY_PACKAGE: label,
          NPM_INSTALL_TEST_NODE_PINNED: '1',
          PATH: pathForNodeMajor(wantMajor),
        },
      });
      ran += 1;
      console.log(`  OK ${label}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${label}: ${err && err.stack ? err.stack : err}`);
    }
    continue;
  }

  console.log(`\n[functional] ${label}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-fn-'));
  const deps = installDepsForPackage(pkg);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fn', private: true, dependencies: deps }, null, 2));
  fs.writeFileSync(path.join(dir, '.npmrc'), npmrcForProxy(PROXY, path.join(dir, '.npm-cache')));

  try {
    const npmArgs = ['install', '--no-audit', '--no-fund', '--foreground-scripts'];
    if (pkg.name === 'react-dom') npmArgs.push('--legacy-peer-deps');
    runWithRetries('npm', npmArgs, {
      cwd: dir,
      env: { ...process.env, npm_config_registry: PROXY, PATH: pathForNodeMajor(wantMajor) },
    });

    // better-sqlite3 postinstall copies @lightwell/*.node → build/Release; it can
    // race ahead of the platform package during a single npm install.
    if (pkg.name === 'better-sqlite3') {
      const shim = path.join(dir, 'node_modules/better-sqlite3/install.js');
      if (fs.existsSync(shim)) runWithRetries('node', [shim], { cwd: dir });
    }

    const factory = suites[pkg.name];
    if (!factory) throw new Error(`no functional suite for ${pkg.name}`);
    const mod = await loadModule(dir, pkg.name, pkg.esm);
    const require = createRequire(path.join(dir, 'package.json'));
    const tests = factory({
      mod,
      require,
      dir,
      version: pkg.version,
      name: pkg.name,
      platformPackage: pkg.platform_package || null,
    });

    if (!Array.isArray(tests) || tests.length !== 5) {
      throw new Error(`${label}: expected exactly 5 tests, got ${tests && tests.length}`);
    }

    for (let i = 0; i < tests.length; i++) {
      await tests[i]();
      console.log(`  ✓ smoke ${i + 1}/5`);
    }
    ran += 1;
    console.log(`  OK ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${label}: ${err && err.stack ? err.stack : err}`);
  }
}

const total = ran + failed;
const smokesOk = ran * 5;
console.log('\n========== FUNCTIONAL SUMMARY ==========');
console.log(`  packages passed: ${ran}`);
console.log(`  packages failed: ${failed}`);
console.log(`  packages total:  ${total}`);
console.log(`  smokes passed:   ${smokesOk} (5 per passed package)`);
console.log('========================================');
if (failed) {
  console.error(`[functional] FAIL (${failed} package(s))`);
  process.exit(1);
}
console.log('[functional] OK');
