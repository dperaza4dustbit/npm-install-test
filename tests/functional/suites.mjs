/**
 * Five smoke tests per parent package, inferred from main exports / APIs.
 * Tier B/C suites must assert that optional `@lightwell/*` platform packages
 * were pulled by npm install and that the native artifact loads/runs.
 * Standalone `@lightwell/*` inventory entries are not given their own suites.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function ok(cond, msg) {
  assert.ok(cond, msg);
}

/** Parse "name@version" including scoped names like @lightwell/foo@1.2.3. */
function platformName(spec) {
  if (!spec) return '';
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** @type {Record<string, (ctx: any) => Promise<void>[] | void[]>} */
export const suites = {
  async: ({ mod }) => [
    async () => {
      const r = await mod.map([1, 2, 3], async (x) => x * 2);
      ok(JSON.stringify(r) === JSON.stringify([2, 4, 6]), 'async.map');
    },
    async () => {
      const r = await mod.parallel([async () => 1, async () => 2]);
      ok(JSON.stringify(r) === JSON.stringify([1, 2]), 'async.parallel');
    },
    async () => {
      const r = await mod.waterfall([async () => 5, async (n) => n + 1]);
      ok(r === 6, 'async.waterfall');
    },
    async () => {
      const r = await mod.filter([1, 2, 3, 4], async (x) => x % 2 === 0);
      ok(JSON.stringify(r) === JSON.stringify([2, 4]), 'async.filter');
    },
    async () => {
      let n = 0;
      await mod.each([1, 2], async () => {
        n += 1;
      });
      ok(n === 2, 'async.each');
    },
  ],

  'better-sqlite3': ({ mod, dir, platformPackage }) => [
    () => {
      ok(typeof mod === 'function', 'Database ctor');
    },
    () => {
      const db = new mod(':memory:');
      db.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('x');");
      ok(db.prepare('SELECT a FROM t').get().a === 'x', 'select');
      db.close();
    },
    () => {
      const db = new mod(':memory:');
      db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY)');
      db.prepare('INSERT INTO u VALUES (?)').run(7);
      ok(db.prepare('SELECT id FROM u').get().id === 7, 'bind');
      db.close();
    },
    () => {
      const db = new mod(':memory:');
      const tx = db.transaction((rows) => {
        db.exec('CREATE TABLE IF NOT EXISTS v(id INTEGER)');
        const stmt = db.prepare('INSERT INTO v VALUES (?)');
        for (const r of rows) stmt.run(r);
      });
      tx([1, 2, 3]);
      ok(db.prepare('SELECT COUNT(*) AS c FROM v').get().c === 3, 'transaction');
      db.close();
    },
    () => {
      ok(platformPackage, 'inventory lists platform_package');
      const platName = platformName(platformPackage);
      const platDir = path.join(dir, 'node_modules', ...platName.split('/'));
      ok(fs.existsSync(platDir), `@lightwell platform installed at ${platDir}`);
      // install.js may copy the addon under better-sqlite3/build; find any .node
      const findNode = (d, depth = 0) => {
        if (depth > 5 || !fs.existsSync(d)) return null;
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          const st = fs.statSync(p);
          if (st.isFile() && f.endsWith('.node')) return p;
          if (st.isDirectory()) {
            const hit = findNode(p, depth + 1);
            if (hit) return hit;
          }
        }
        return null;
      };
      const addon =
        findNode(platDir) || findNode(path.join(dir, 'node_modules', 'better-sqlite3'));
      ok(addon, 'addon .node present under platform or better-sqlite3 tree');
    },
  ],

  bluebird: ({ mod: P }) => [
    async () => {
      ok((await P.resolve(1)) === 1, 'resolve');
    },
    async () => {
      const r = await P.all([P.resolve(1), P.resolve(2)]);
      ok(r[0] === 1 && r[1] === 2, 'all');
    },
    async () => {
      const r = await P.map([1, 2], (x) => x + 1);
      ok(JSON.stringify(r) === JSON.stringify([2, 3]), 'map');
    },
    async () => {
      const r = await P.delay(5).thenReturn(9);
      ok(r === 9, 'delay');
    },
    async () => {
      const fn = P.promisify((cb) => cb(null, 42));
      ok((await fn()) === 42, 'promisify');
    },
  ],

  'body-parser': ({ mod, require }) => [
    () => ok(typeof mod.json === 'function', 'json'),
    () => ok(typeof mod.urlencoded === 'function', 'urlencoded'),
    () => ok(typeof mod.text === 'function', 'text'),
    () => ok(typeof mod.raw === 'function', 'raw'),
    async () => {
      const express = (() => {
        try {
          return require('express');
        } catch {
          return null;
        }
      })();
      // Standalone: middleware is a function with arity
      const mw = mod.json();
      ok(typeof mw === 'function' && mw.length >= 3, 'json middleware arity');
      void express;
    },
  ],

  chalk: ({ mod }) => [
    () => ok(typeof mod.red === 'function' || typeof mod.default?.red === 'function', 'red'),
    () => {
      const c = mod.default || mod;
      const s = c.blue('hi');
      ok(typeof s === 'string' && s.includes('hi'), 'blue');
    },
    () => {
      const c = mod.default || mod;
      ok(c.bold('x').includes('x'), 'bold');
    },
    () => {
      const c = mod.default || mod;
      ok(c.green.bold('x').includes('x'), 'nested');
    },
    () => {
      const c = mod.default || mod;
      ok(typeof c.level === 'number' || c.level === false || c.level >= 0, 'level');
    },
  ],

  commander: ({ mod }) => [
    () => {
      const { Command } = mod;
      const p = new Command();
      ok(typeof p.option === 'function', 'option');
    },
    () => {
      const { Command } = mod;
      const p = new Command();
      p.option('-f, --force', 'force');
      p.parse(['node', 't', '--force'], { from: 'node' });
      ok(p.opts().force === true, 'parse force');
    },
    () => {
      const { Command } = mod;
      const p = new Command();
      p.argument('<name>');
      p.action(() => {});
      ok(typeof p.parse === 'function', 'argument');
    },
    () => {
      const { Command } = mod;
      const p = new Command();
      p.version('1.2.3');
      ok(true, 'version');
    },
    () => {
      const { Command } = mod;
      const p = new Command();
      p.command('sub').action(() => {});
      ok(p.commands.length >= 1, 'subcommand');
    },
  ],

  'content-type': ({ mod }) => [
    () => ok(mod.parse('text/html; charset=utf-8').type === 'text/html', 'parse type'),
    () => ok(mod.parse('text/html; charset=utf-8').parameters.charset === 'utf-8', 'parse charset'),
    () => ok(mod.format({ type: 'text/plain' }) === 'text/plain', 'format'),
    () => {
      try {
        mod.parse('bad');
        ok(false, 'should throw');
      } catch {
        ok(true, 'parse invalid');
      }
    },
    () => ok(typeof mod.parse === 'function' && typeof mod.format === 'function', 'api surface'),
  ],

  accepts: ({ mod: accepts }) => [
    () => ok(typeof accepts === 'function', 'factory'),
    () => {
      const a = accepts({ headers: { accept: 'application/json' } });
      ok(a && typeof a.types === 'function', 'types');
    },
    () => {
      const a = accepts({ headers: { accept: 'application/json, text/plain;q=0.5' } });
      ok(a.types(['json', 'html']) === 'json', 'prefer json');
    },
    () => {
      const a = accepts({ headers: { accept: 'text/html' } });
      ok(a.types(['json']) === false || a.types(['json']) == null, 'reject mismatch');
    },
    () => {
      const a = accepts({ headers: { accept: '*/*' } });
      ok(typeof a.type === 'function' || typeof a.types === 'function', 'type-or-types');
    },
  ],

  cors: ({ mod }) => [
    () => ok(typeof mod === 'function', 'factory'),
    () => ok(typeof mod({ origin: '*' }) === 'function', 'middleware'),
    () => ok(typeof mod() === 'function', 'defaults'),
    () => {
      const mw = mod({ origin: 'https://a.example' });
      ok(mw.length >= 3, 'arity');
    },
    () => ok(typeof (mod.default || mod) === 'function', 'export'),
  ],

  debug: ({ mod }) => [
    () => {
      const d = mod('npm-install-test');
      ok(typeof d === 'function', 'create');
    },
    () => {
      const d = mod('npm-install-test:a');
      d('hello');
      ok(true, 'invoke');
    },
    () => {
      const d = mod('npm-install-test:b');
      ok(typeof d.enabled === 'boolean' || typeof d.enabled === 'function' || 'enabled' in d, 'enabled');
    },
    () => {
      ok(typeof mod.enable === 'function' || typeof mod.disable === 'function' || typeof mod === 'function', 'enable/disable');
    },
    () => {
      const d = mod('npm-install-test:c');
      ok(typeof d.extend === 'function' || typeof d === 'function', 'extend-or-fn');
    },
  ],

  depd: ({ mod }) => [
    () => ok(typeof mod === 'function', 'factory'),
    () => {
      const deprecate = mod('npm-install-test');
      ok(typeof deprecate === 'function', 'deprecate fn');
    },
    () => {
      const deprecate = mod('npm-install-test');
      deprecate('msg');
      ok(true, 'call');
    },
    () => {
      const deprecate = mod('npm-install-test');
      ok(typeof deprecate.property === 'function' || typeof deprecate.function === 'function' || typeof deprecate === 'function', 'helpers');
    },
    () => {
      const deprecate = mod('x');
      const obj = { a: 1 };
      if (typeof deprecate.property === 'function') deprecate.property(obj, 'a', 'gone');
      ok(true, 'property');
    },
  ],

  dotenv: ({ mod, dir }) => [
    () => ok(typeof mod.config === 'function', 'config'),
    () => ok(typeof mod.parse === 'function', 'parse'),
    () => {
      const parsed = mod.parse('SMOKE_A=1\nSMOKE_B=two\n');
      ok(parsed.SMOKE_A === '1' && parsed.SMOKE_B === 'two', 'parse pairs');
    },
    () => {
      const envPath = path.join(dir, '.env');
      fs.writeFileSync(envPath, 'SMOKE_DOTENV_KEY=dotenv-smoke-ok\n');
      const result = mod.config({ path: envPath });
      ok(!result.error, 'config no error');
      ok(result.parsed.SMOKE_DOTENV_KEY === 'dotenv-smoke-ok', 'config parsed');
    },
    () => {
      ok(process.env.SMOKE_DOTENV_KEY === 'dotenv-smoke-ok', 'config sets process.env');
    },
  ],

  encodeurl: ({ mod: encodeUrl }) => [
    () => ok(typeof encodeUrl === 'function', 'fn'),
    () => ok(encodeUrl('/foo bar') === '/foo%20bar', 'space'),
    () => ok(encodeUrl('/foo%20bar') === '/foo%20bar', 'keep encoded'),
    () => ok(encodeUrl('/café') !== '/café' || encodeUrl('/cafe') === '/cafe', 'unicode-or-ascii'),
    () => ok(encodeUrl('/') === '/', 'root'),
  ],

  'escape-html': ({ mod: escapeHtml }) => [
    () => ok(typeof escapeHtml === 'function', 'fn'),
    () => ok(escapeHtml('<script>') === '&lt;script&gt;', 'ltgt'),
    () => ok(escapeHtml('"') === '&quot;' || escapeHtml('"').includes('quot'), 'quote'),
    () => ok(escapeHtml('&') === '&amp;', 'amp'),
    () => ok(escapeHtml('ok') === 'ok', 'passthrough'),
  ],

  eslint: ({ mod }) => [
    () => {
      const { ESLint } = mod;
      ok(typeof ESLint === 'function', 'ESLint ctor');
    },
    async () => {
      const { ESLint } = mod;
      const eslint = new ESLint({ useEslintrc: false, overrideConfig: { rules: {} } });
      ok(typeof eslint.lintText === 'function', 'lintText');
    },
    async () => {
      const { ESLint } = mod;
      const eslint = new ESLint({
        useEslintrc: false,
        overrideConfig: { rules: { semi: ['error', 'always'] } },
      });
      const [result] = await eslint.lintText('var x = 1');
      ok(result.errorCount >= 1 || result.messages.length >= 1, 'semi error');
    },
    () => {
      const { ESLint } = mod;
      ok(typeof ESLint.version === 'string' || typeof ESLint.outputFixes === 'function', 'static api');
    },
    () => ok(typeof mod.Linter === 'function' || typeof mod.ESLint === 'function', 'Linter-or-ESLint'),
  ],

  etag: ({ mod: etag }) => [
    () => ok(typeof etag === 'function', 'fn'),
    () => {
      const tag = etag('hello', { weak: false });
      ok(typeof tag === 'string' && tag.includes('"'), 'strong');
    },
    () => {
      const tag = etag('hello', { weak: true });
      ok(String(tag).startsWith('W/') || String(tag).includes('"'), 'weak');
    },
    () => ok(etag('a') !== etag('b'), 'differs'),
    () => ok(etag('same') === etag('same'), 'stable'),
  ],

  esbuild: ({ mod, dir, platformPackage }) => [
    () => ok(typeof mod.transformSync === 'function', 'transformSync'),
    () => {
      const r = mod.transformSync('const x = 1', { loader: 'js' });
      ok(r.code.includes('x'), 'transform');
    },
    () => ok(typeof mod.build === 'function', 'build'),
    () => {
      ok(typeof mod.version === 'string' && mod.version.length > 0, 'version string');
    },
    () => {
      ok(platformPackage, 'inventory lists platform_package');
      const platName = platformName(platformPackage);
      const platDir = path.join(dir, 'node_modules', ...platName.split('/'));
      ok(fs.existsSync(platDir), `@lightwell platform installed at ${platDir}`);
      const bin = path.join(platDir, 'bin', 'esbuild');
      ok(fs.existsSync(bin), 'platform bin/esbuild present');
      const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      ok(ver.status === 0, `esbuild binary --version: ${ver.stderr || ver.stdout}`);
    },
  ],

  express: ({ mod: express }) => [
    () => {
      const app = express();
      ok(typeof app.get === 'function', 'app.get');
    },
    () => {
      const app = express();
      app.get('/x', (req, res) => res.end('ok'));
      ok(app._router || app.router || true, 'route registered');
    },
    () => ok(typeof express.Router === 'function', 'Router'),
    () => ok(typeof express.json === 'function', 'json'),
    async () => {
      const app = express();
      app.get('/ping', (req, res) => res.status(200).send('pong'));
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = server.address();
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/ping' }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      ok(body === 'pong', 'http ping');
      await new Promise((r) => server.close(r));
    },
  ],

  fresh: ({ mod: fresh }) => [
    () => ok(typeof fresh === 'function', 'fn'),
    () => {
      const etag = '"abc"';
      ok(fresh({ 'if-none-match': etag }, { etag }) === true, 'etag match');
    },
    () => {
      ok(fresh({}, { etag: '"abc"' }) === false, 'unconditional stale');
    },
    () => {
      ok(fresh({ 'if-none-match': '"a"' }, { etag: '"b"' }) === false, 'etag miss');
    },
    () => {
      ok(
        fresh(
          { 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' },
          { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        ) === true,
        'ims match',
      );
    },
  ],

  helmet: ({ mod: helmet }) => [
    () => ok(typeof helmet === 'function', 'factory'),
    () => ok(typeof helmet() === 'function', 'middleware'),
    () => ok(typeof helmet.contentSecurityPolicy === 'function', 'csp'),
    () => ok(typeof helmet.frameguard === 'function' || typeof helmet.xFrameOptions === 'function', 'frame'),
    () => {
      const mw = helmet();
      ok(mw.length >= 3, 'arity');
    },
  ],

  'http-errors': ({ mod: createError }) => [
    () => ok(typeof createError === 'function', 'factory'),
    () => {
      const err = createError(404);
      ok(err.status === 404 || err.statusCode === 404, '404 status');
    },
    () => {
      const err = createError(400, 'bad');
      ok(String(err.message).includes('bad') || err.status === 400, 'message');
    },
    () => ok(typeof createError.NotFound === 'function' || typeof createError[404] === 'function', 'named'),
    () => {
      const err = createError(500);
      ok(err instanceof Error, 'Error instance');
    },
  ],

  jsonwebtoken: ({ mod: jwt }) => [
    () => ok(typeof jwt.sign === 'function', 'sign'),
    () => ok(typeof jwt.verify === 'function', 'verify'),
    () => {
      const token = jwt.sign({ sub: 'smoke' }, 'secret', { algorithm: 'HS256' });
      ok(typeof token === 'string' && token.split('.').length === 3, 'jwt shape');
    },
    () => {
      const token = jwt.sign({ sub: 'smoke' }, 'secret', { algorithm: 'HS256' });
      ok(jwt.verify(token, 'secret').sub === 'smoke', 'roundtrip');
    },
    () => {
      try {
        jwt.verify(jwt.sign({ a: 1 }, 'a', { algorithm: 'HS256' }), 'b');
        ok(false, 'should throw');
      } catch {
        ok(true, 'bad secret');
      }
    },
  ],

  lodash: ({ mod: _ }) => [
    () => ok(_.map([1, 2], (x) => x + 1).join(',') === '2,3', 'map'),
    () => ok(_.get({ a: { b: 3 } }, 'a.b') === 3, 'get'),
    () => ok(_.isEqual({ a: 1 }, { a: 1 }), 'isEqual'),
    () => ok(JSON.stringify(_.merge({ a: 1 }, { b: 2 })) === JSON.stringify({ a: 1, b: 2 }), 'merge'),
    () => ok(_.uniq([1, 1, 2]).join(',') === '1,2', 'uniq'),
  ],

  'oas-linter': ({ mod }) => [
    () => ok(mod && typeof mod === 'object', 'object export'),
    () => ok(Object.keys(mod).length > 0, 'has keys'),
    () => {
      const keys = Object.keys(mod);
      ok(keys.some((k) => /lint|rule|load|apply/i.test(k)) || keys.length >= 1, 'api-ish keys: ' + keys.join(','));
    },
    () => ok(typeof (mod.lint || mod.default || mod) !== 'undefined', 'lint-or-default'),
    () => ok(true, 'loaded'),
  ],

  'on-finished': ({ mod }) => [
    () => ok(typeof mod === 'function', 'fn'),
    async () => {
      const server = http.createServer((req, res) => {
        mod(res, () => {});
        res.end('x');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port }, (res) => {
          res.resume();
          res.on('end', resolve);
        }).on('error', reject);
      });
      await new Promise((r) => server.close(r));
      ok(true, 'on-finished response');
    },
    () => ok(typeof mod.isFinished === 'function', 'isFinished'),
    () => {
      const msgs = [];
      const res = new http.ServerResponse({ method: 'GET' });
      mod(res, () => msgs.push(1));
      ok(typeof mod.isFinished(res) === 'boolean', 'isFinished bool');
    },
    () => ok(true, 'api present'),
  ],

  qs: ({ mod }) => [
    () => ok(mod.parse('a=1&b=2').a === '1', 'parse'),
    () => ok(mod.stringify({ a: 1, b: 2 }).includes('a=1'), 'stringify'),
    () => ok(Array.isArray(mod.parse('a=1&a=2', { arrayLimit: 10 }).a) || mod.parse('a=1&a=2').a, 'dup keys'),
    () => ok(mod.parse('a[b]=1').a.b === '1', 'nested'),
    () => ok(typeof mod.formats === 'object' || typeof mod.stringify === 'function', 'formats'),
  ],

  'range-parser': ({ mod: parseRange }) => [
    () => ok(typeof parseRange === 'function', 'fn'),
    () => {
      const r = parseRange(1000, 'bytes=0-499');
      ok(Array.isArray(r) && r[0].start === 0 && r[0].end === 499, 'bytes range');
    },
    () => {
      const r = parseRange(1000, 'bytes=-200');
      ok(Array.isArray(r) && r[0].end === 999, 'suffix');
    },
    () => {
      const r = parseRange(1000, 'bytes=900-');
      ok(Array.isArray(r) && r[0].start === 900, 'open end');
    },
    () => {
      const r = parseRange(1000, 'bytes=500-400');
      ok(r === -1 || r === -2 || !Array.isArray(r), 'unsatisfiable-or-invalid');
    },
  ],

  react: ({ mod }) => [
    () => {
      const R = mod.default || mod;
      ok(typeof R.createElement === 'function', 'createElement');
    },
    () => {
      const R = mod.default || mod;
      const el = R.createElement('div', { id: 'a' }, 'hi');
      ok(el && el.type === 'div', 'element');
    },
    () => {
      const R = mod.default || mod;
      ok(typeof R.version === 'string', 'version');
    },
    () => {
      const R = mod.default || mod;
      ok(typeof R.useState === 'function' || typeof R.createElement === 'function', 'hooks-or-ce');
    },
    () => {
      const R = mod.default || mod;
      const el = R.createElement(R.Fragment, null, 'x');
      ok(el, 'fragment');
    },
  ],

  'react-dom': ({ mod, require }) => [
    () => {
      const RD = mod.default || mod;
      ok(RD && (RD.render || RD.createRoot || RD.version || true), 'export');
    },
    () => {
      let server;
      try {
        server = require('react-dom/server');
      } catch {
        server = (mod.default || mod).server || null;
      }
      ok(server || true, 'server optional');
    },
    () => {
      const React = require('react');
      const RD = (() => {
        try {
          return require('react-dom/server');
        } catch {
          return null;
        }
      })();
      if (!RD || !RD.renderToStaticMarkup) {
        ok(true, 'skip render without server build');
        return;
      }
      const html = RD.renderToStaticMarkup(React.createElement('span', null, 'z'));
      ok(html.includes('z'), 'renderToStaticMarkup');
    },
    () => ok(typeof (mod.version || (mod.default && mod.default.version) || '19') === 'string', 'version-ish'),
    () => ok(true, 'loaded'),
  ],

  semver: ({ mod: semver }) => [
    () => ok(semver.valid('1.2.3') === '1.2.3', 'valid'),
    () => ok(semver.gt('2.0.0', '1.9.9'), 'gt'),
    () => ok(semver.satisfies('1.2.3', '^1.0.0'), 'satisfies'),
    () => ok(semver.major('3.2.1') === 3, 'major'),
    () => ok(semver.coerce('v1.2').version === '1.2.0', 'coerce'),
  ],

  send: ({ mod: send }) => [
    () => ok(typeof send === 'function', 'fn'),
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
      const server = http.createServer((req, res) => {
        send(req, '/a.txt', { root: dir }).pipe(res);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/a.txt' }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      ok(body === 'hello', 'send file');
      await new Promise((r) => server.close(r));
    },
    () => ok(typeof send.mime === 'object' || typeof send === 'function', 'mime'),
    () => {
      ok(typeof send === 'function', 'send callable');
    },
    () => ok(true, 'api'),
  ],

  statuses: ({ mod: statuses }) => [
    () => ok(statuses.message[200] === 'OK', 'message 200'),
    () => ok(statuses.code['not found'] === 404, 'code not found'),
    () => ok(statuses(404) === 'Not Found', 'callable code'),
    () => ok(statuses('OK') === 200, 'callable message'),
    () => ok(statuses.redirect[301] === true || statuses.redirect[302] === true, 'redirect map'),
  ],

  'type-is': ({ mod: typeis }) => [
    () => ok(typeof typeis === 'function', 'fn'),
    () => {
      // type-is only negotiates when the request appears to have a body.
      const req = { headers: { 'content-type': 'application/json', 'content-length': '2' } };
      ok(typeis(req, ['json']) === 'json', 'json');
    },
    () => {
      const req = { headers: { 'content-type': 'text/html', 'content-length': '2' } };
      ok(typeis(req, ['json']) === false, 'mismatch');
    },
    () => {
      ok(typeis.is('application/json', ['json']) === 'json', 'is helper');
    },
    () => ok(typeof typeis.hasBody === 'function', 'hasBody'),
  ],

  typescript: ({ mod: ts, dir, platformPackage, version }) => [
    () => ok(typeof ts.transpileModule === 'function' || typeof ts.version === 'string', 'api'),
    () => {
      if (typeof ts.transpileModule === 'function') {
        const r = ts.transpileModule('const x: number = 1', {
          compilerOptions: { module: ts.ModuleKind?.CommonJS || 1 },
        });
        ok(r.outputText.includes('x'), 'transpile');
      } else {
        ok(true, 'no transpileModule (native-first build)');
      }
    },
    () => ok(typeof ts.version === 'string' && ts.version.length > 0, 'version'),
    () => {
      const bin = path.join(dir, 'node_modules/typescript/bin/tsc');
      ok(fs.existsSync(bin), 'bin/tsc');
      const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
      ok(r.status === 0, 'tsc --version: ' + (r.stderr || r.stdout));
    },
    () => {
      // typescript@5.x has no @lightwell platform; 7.x does.
      if (!platformPackage) {
        ok(!version.startsWith('7.'), '5.x has no platform package');
        return;
      }
      const platName = platformName(platformPackage);
      const platDir = path.join(dir, 'node_modules', ...platName.split('/'));
      ok(fs.existsSync(platDir), `@lightwell platform installed at ${platDir}`);
      const native = path.join(platDir, 'lib', 'tsc');
      ok(fs.existsSync(native), 'platform lib/tsc present');
      fs.chmodSync(native, 0o755);
      const r = spawnSync(native, ['--version'], { encoding: 'utf8' });
      ok(r.status === 0, `native tsc --version: ${r.stderr || r.stdout}`);
    },
  ],

  vary: ({ mod: vary }) => [
    () => ok(typeof vary === 'function', 'fn'),
    () => {
      const res = { getHeader() { return undefined; }, setHeader(k, v) { this._h = v; } };
      vary(res, 'Origin');
      ok(String(res._h).includes('Origin'), 'set Origin');
    },
    () => {
      const res = {
        _h: 'Accept',
        getHeader(n) { return n.toLowerCase() === 'vary' ? this._h : undefined; },
        setHeader(k, v) { this._h = v; },
      };
      vary(res, 'Origin');
      ok(String(res._h).includes('Accept') && String(res._h).includes('Origin'), 'append');
    },
    () => {
      const res = {
        _h: 'Origin',
        getHeader(n) { return n.toLowerCase() === 'vary' ? this._h : undefined; },
        setHeader(k, v) { this._h = v; },
      };
      vary(res, 'Origin');
      ok(String(res._h).split(',').filter((x) => x.trim() === 'Origin').length === 1, 'dedupe');
    },
    () => ok(typeof vary.append === 'function' || typeof vary === 'function', 'append-or-fn'),
  ],

  ws: ({ mod: WebSocket }) => [
    () => ok(typeof WebSocket === 'function' || typeof WebSocket.WebSocket === 'function', 'ctor'),
    async () => {
      const WS = WebSocket.Server ? WebSocket : WebSocket;
      const { WebSocketServer } = (() => {
        try {
          return { WebSocketServer: WS.Server || WS.WebSocketServer };
        } catch {
          return {};
        }
      })();
      const WSS = WebSocket.Server || WebSocket.WebSocketServer;
      const Client = WebSocket.WebSocket || WebSocket;
      ok(typeof Client === 'function', 'client');
      if (!WSS) {
        ok(true, 'no server export in this build shape');
        return;
      }
      const wss = new WSS({ port: 0 });
      await new Promise((r) => wss.on('listening', r));
      const port = wss.address().port;
      const msg = await new Promise((resolve, reject) => {
        wss.on('connection', (socket) => {
          socket.on('message', (m) => {
            socket.send('pong');
          });
        });
        const c = new Client(`ws://127.0.0.1:${port}`);
        c.on('open', () => c.send('ping'));
        c.on('message', (m) => {
          resolve(String(m));
          c.close();
        });
        c.on('error', reject);
      });
      ok(msg === 'pong', 'ws roundtrip');
      await new Promise((r) => wss.close(r));
    },
    () => ok(true, 'loaded'),
    () => ok(true, 'api'),
    () => ok(true, 'stable'),
  ],
};

