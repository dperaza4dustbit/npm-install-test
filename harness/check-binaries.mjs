#!/usr/bin/env node
/**
 * Install each native-tier parent (B/C) and assert @lightwell platform packages
 * load and run (not ELF-only).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  loadInventory,
  run,
  runWithRetries,
  assert,
  npmrcForProxy,
  installDepsForPackage,
  parsePlatformPackage,
  nodeBinForMajor,
  pathForNodeMajor,
} from './lib.mjs';

const PROXY = process.env.NPM_PROXY_URL || 'http://127.0.0.1:4874';
const inv = loadInventory();
const natives = inv.packages.filter((p) => p.kind === 'package' && (p.native_tier === 'B' || p.native_tier === 'C'));
const self = fileURLToPath(import.meta.url);
const currentMajor = Number(process.versions.node.split('.')[0]);
const only = process.env.ONLY_PACKAGE;
const nodePinned = process.env.NPM_INSTALL_TEST_NODE_PINNED === '1';

async function installOne(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `npm-bin-${pkg.name.replace(/[/]/g, '_')}-`));
  const wantMajor = Number(pkg.node_major) || 22;
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'bin-check', private: true, dependencies: installDepsForPackage(pkg) }, null, 2),
  );
  fs.writeFileSync(path.join(dir, '.npmrc'), npmrcForProxy(PROXY, path.join(dir, '.npm-cache')));
  runWithRetries('npm', ['install', '--no-audit', '--no-fund', '--foreground-scripts'], {
    cwd: dir,
    env: { ...process.env, npm_config_registry: PROXY, PATH: pathForNodeMajor(wantMajor) },
  });
  if (pkg.name === 'better-sqlite3') {
    const shim = path.join(dir, 'node_modules/better-sqlite3/install.js');
    if (fs.existsSync(shim)) runWithRetries('node', [shim], { cwd: dir });
  }
  return dir;
}

function requireFrom(dir, id) {
  const req = createRequire(path.join(dir, 'package.json'));
  return req(id);
}

let failed = 0;
let passed = 0;
for (const p of natives) {
  if (only && p.name !== only && `${p.name}@${p.version}` !== only) continue;
  const label = `${p.name}@${p.version}`;
  const wantMajor = Number(p.node_major) || 22;

  if (wantMajor !== currentMajor && !process.env.NPM_INSTALL_TEST_NODE_PINNED) {
    console.log(`\n[binaries] ${label} (Node ${wantMajor})`);
    try {
      run(nodeBinForMajor(wantMajor), [self], {
        stdio: 'inherit',
        encoding: undefined,
        env: {
          ...process.env,
          ONLY_PACKAGE: label,
          NPM_INSTALL_TEST_NODE_PINNED: '1',
          PATH: pathForNodeMajor(wantMajor),
        },
      });
      passed += 1;
      // Child printed detail / OK lines; parent prints the suite summary.
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${label}: ${err.message || err}`);
    }
    continue;
  }

  if (!nodePinned) {
    console.log(`\n[binaries] ${label} (node_major=${p.node_major})`);
  }
  try {
    const dir = await installOne(p);
    const platform = p.platform_package;
    assert(platform, `${label}: inventory missing platform_package`);
    const { name: platName } = parsePlatformPackage(platform);
    const platDir = path.join(dir, 'node_modules', ...platName.split('/'));
    assert(fs.existsSync(platDir), `${label}: @lightwell platform not installed at ${platDir}`);

    if (p.name === 'esbuild') {
      const esbuild = requireFrom(dir, 'esbuild');
      assert(typeof esbuild.transformSync === 'function', 'esbuild.transformSync missing');
      const out = esbuild.transformSync('export const x = 1', { loader: 'js', format: 'cjs' });
      assert(out.code.includes('x'), 'esbuild transform produced unexpected code');
      const ver = run(path.join(dir, 'node_modules/esbuild/bin/esbuild'), ['--version'], { cwd: dir });
      assert(ver.stdout.trim() === p.version, `esbuild --version want ${p.version} got ${ver.stdout.trim()}`);
      console.log('  esbuild transform + binary OK');
    } else if (p.name === 'better-sqlite3') {
      const Database = requireFrom(dir, 'better-sqlite3');
      const db = new Database(':memory:');
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);');
      const row = db.prepare('SELECT id FROM t').get();
      assert(row && row.id === 1, 'better-sqlite3 query failed');
      db.close();
      console.log('  better-sqlite3 load + query OK');
    } else if (p.name === 'typescript') {
      const tscJs = path.join(dir, 'node_modules/typescript/bin/tsc');
      assert(fs.existsSync(tscJs), 'typescript bin/tsc missing');
      const ver = run('node', [tscJs, '--version'], { cwd: dir });
      assert(
        ver.stdout.toLowerCase().includes('typescript') || ver.stdout.includes(p.version.split('.')[0]),
        `tsc --version unexpected: ${ver.stdout}`,
      );
      const platBin = path.join(dir, 'node_modules/@lightwell/typescript-linux-x64/lib/tsc');
      if (fs.existsSync(platBin)) {
        fs.chmodSync(platBin, 0o755);
        const nativeVer = run(platBin, ['--version'], { cwd: dir });
        console.log(`  native tsc: ${nativeVer.stdout.trim()}`);
      }
      console.log('  typescript tsc OK');
    } else {
      throw new Error(`no binary check implemented for ${p.name}`);
    }
    passed += 1;
    console.log(`  OK ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${label}: ${err.message || err}`);
  }
}

if (nodePinned) {
  if (failed) process.exit(1);
  process.exit(0);
}

console.log('\n========== BINARIES SUMMARY ==========');
console.log(`  parents passed: ${passed}`);
console.log(`  parents failed: ${failed}`);
console.log(`  parents total:  ${passed + failed}`);
console.log('======================================');
if (failed) {
  console.error(`[binaries] FAIL (${failed} parent(s))`);
  process.exit(1);
}
console.log('[binaries] OK');

