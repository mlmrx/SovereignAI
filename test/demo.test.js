// The public command-center demo ships the app's real interface files and
// answers their calls from a fixture. That is only safe if the demo layer is
// provably inert on a real instance and provably incapable of carrying a
// credential on the public origin — both pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const pub = (file) => fs.readFileSync(path.join(root, 'public', file), 'utf8');
const demo = pub('demo-api.js');

test('the demo layer is inert anywhere but the public host', () => {
  // The very first thing it does is leave, on any other hostname.
  assert.match(
    demo,
    /if \(!\/\(\^\|\\\.\)mysovereign\\\.ai\$\|\\\.vercel\\\.app\$\/\.test\(location\.hostname\)\) return;/,
    'demo-api.js must return immediately off the public host'
  );
  const guardAt = demo.indexOf('location.hostname');
  assert.ok(guardAt > 0 && guardAt < 900, 'the guard must come before anything else runs');
  assert.ok(demo.indexOf('window.fetch =') > guardAt, 'fetch is only replaced past the guard');

  // Executed as a real script with a non-public hostname, it must not touch fetch.
  const sentinel = () => 'untouched';
  const sandbox = {
    location: { hostname: 'localhost', href: 'http://localhost:4321/' },
    window: { fetch: sentinel },
    addEventListener() {},
    document: { createElement: () => ({ style: {}, append() {} }), body: {} },
    Response: class {}, ReadableStream: class {}, TextEncoder: class {},
    setTimeout, console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.fetch = sentinel;
  vm.runInNewContext(demo, sandbox, { filename: 'public/demo-api.js' });
  assert.equal(sandbox.fetch, sentinel, 'a real instance keeps its own fetch');
});

test('the demo can never carry a credential or reach a network', () => {
  // app.js drops the token entirely on the public host.
  const app = pub('app.js');
  assert.match(app, /window\.SOVEREIGN_PUBLIC_DEMO = /, 'app.js must know when it is the public demo');
  assert.match(app, /if \(window\.SOVEREIGN_PUBLIC_DEMO\) return \{\};/, 'no auth header may be sent from the public demo');
  assert.match(app, /token && window\.SOVEREIGN_PUBLIC_DEMO/, 'a pasted #token= must be discarded, not stored');

  // Everything under /api is answered locally; only non-API URLs pass through,
  // and the pass-through forwards the caller's own arguments untouched. (The
  // absolute URLs in the fixture are provider baseUrls rendered in Settings —
  // strings the demo displays, never addresses it calls.)
  assert.match(demo, /if \(!url\.startsWith\('\/api\/'\)\) return realFetch/, 'API calls must never leave the browser');
  assert.equal((demo.match(/realFetch\(/g) || []).length, 1, 'exactly one pass-through call site');
  assert.match(demo, /return realFetch\(input, init\);/, 'the pass-through must not rewrite the request');
  assert.doesNotMatch(demo, /XMLHttpRequest|navigator\.sendBeacon|new WebSocket|EventSource/, 'no side channel out of the page');
});

test('the demo is never a dead end: the site frame goes on top of the app', () => {
  // The app owns the viewport, so without this a visitor who clicked in had
  // no way back out to the website.
  assert.match(demo, /className = 'shell-bar'/, 'the shared header must be injected');
  assert.match(demo, /link\.href = '\/shell\.css'/, 'it must use the shared stylesheet, not a copy of it');
  assert.match(demo, /brand\.href = '\/'/, 'the brand must lead home');
  // The app puts its own brand mark beside ours, so "Home" is spelled out
  // rather than left to the logo.
  assert.match(demo, /\['\/', 'Home'\]/, 'the injected header must name Home explicitly');
  for (const [href] of [['/watch'], ['/sovereignty'], ['/playground']]) {
    assert.ok(demo.includes(`'${href}'`), `the frame must still reach ${href}`);
  }
  assert.match(demo, /paddingTop = '47px'/, 'the app must be pushed clear of the header, not covered by it');
  // The site's theme script would stamp a data-theme onto a UI that has its
  // own appearance, so the frame is styles only — never that script.
  assert.doesNotMatch(demo, /['"]\/shell\.js['"]/, 'the app must not load the site theme script');
});

test('the demo says what it is, and points at the real thing', () => {
  assert.match(demo, /how it works<\/b> — the real interface, an invented workspace/, 'the banner must state the fiction');
  assert.match(demo, /No server behind this page/, 'and that nothing is running behind it');
  assert.match(demo, /cta\.href = '\/#install'/, 'and offer the real product');
  // Its resident matches every other demo surface, so the playground tells one story.
  assert.match(demo, /name: 'Atlas'/, 'the demo workspace is Atlas, like the other surfaces');
});

test('the demo is wired: route, deploy allowlist, script order, hub card', () => {
  const config = JSON.parse(pub('vercel.json'));
  const routes = new Map(config.rewrites.map((r) => [r.source, r.destination]));
  assert.equal(routes.get('/command-center'), '/app.html', '/demo must serve the app itself');

  const ignore = pub('.vercelignore');
  for (const file of ['app.html', 'app.js', 'style.css', 'demo-api.js', 'wizard.js', 'finetune.js']) {
    assert.ok(ignore.includes(`!${file}`), `${file} must be deployed for the demo to run`);
  }

  // The regression this cost us once: Vercel serves a matching static file
  // BEFORE it applies rewrites, so shipping a file named index.html into the
  // web root silently claims "/" and shadows the landing page. The app shell
  // is app.html precisely so the front door stays the front door.
  assert.equal(routes.get('/'), '/land.html', 'the site root must serve the landing page');
  assert.ok(!fs.existsSync(path.join(root, 'public', 'index.html')), 'no index.html may sit in the web root');
  assert.ok(!ignore.includes('!index.html'), 'index.html must never be added to the deploy');

  // Order is load-bearing: the fixture must be installed before the app boots.
  const html = pub('app.html');
  assert.ok(
    html.indexOf('/demo-api.js') < html.indexOf('/app.js'),
    'demo-api.js must load before app.js or the first calls escape'
  );
  assert.match(pub('playground.html'), /href="\/command-center"/, 'the playground must link the command center');
});
