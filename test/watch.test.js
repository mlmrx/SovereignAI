// The watch sequence runs on requestAnimationFrame, which headless browsers do not
// advance under a virtual clock — screenshots of it are frozen on shot one no
// matter how long the budget. So the projector is verified here instead: the
// real film.js is executed against a stub document and a clock this test
// drives, and every shot must arrive, in order, and the film must end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'watch.js'), 'utf8');

// A canvas context that accepts every drawing call and remembers nothing.
const stubCtx = new Proxy({}, {
  get: (target, prop) => (prop in target ? target[prop] : () => {}),
  set: (target, prop, value) => { target[prop] = value; return true; },
});

function makeEl(id) {
  const listeners = {};
  return {
    id,
    hidden: false,
    textContent: '',
    innerHTML: '',
    style: { setProperty() {}, transition: '', opacity: '', overflow: '' },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null,
    appendChild() {}, scrollIntoView() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { listeners.click?.(); },
    getContext: () => stubCtx,
    clientWidth: 1280, clientHeight: 760, width: 1280, height: 760,
  };
}

function runFilm({ reduced = false } = {}) {
  const els = new Map();
  const el = (key) => {
    if (!els.has(key)) els.set(key, makeEl(key));
    return els.get(key);
  };
  // Every line the caption is asked to display, in the order it was asked.
  const captions = [];
  const lineEl = el('#line');
  Object.defineProperty(lineEl, 'innerHTML', {
    get: () => lineEl._html ?? '',
    set: (v) => { lineEl._html = v; captions.push(v); },
  });

  let frameCb = null;
  const timers = [];
  const sandbox = {
    matchMedia: () => ({ matches: reduced }),
    devicePixelRatio: 2,
    document: {
      querySelector: (sel) => el(sel),
      createElement: () => makeEl('el'),
      body: { style: {} },
    },
    requestAnimationFrame: (cb) => { frameCb = cb; return 1; },
    cancelAnimationFrame: () => { frameCb = null; },
    addEventListener: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    window: {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'public/watch.js' });

  // Drive the clock ourselves: 16ms a frame, capped well past the film's run.
  let now = 0;
  let frames = 0;
  while (frameCb && frames < 20000) {
    const cb = frameCb;
    frameCb = null;
    now += 16;
    frames++;
    cb(now);
    // finish() defers dismiss() through a timer; run whatever is pending.
    while (timers.length) timers.shift().fn();
  }
  return { captions, frames, runtimeMs: now, film: el('#film') };
}

test('the projector advances through every shot, in order, and ends', () => {
  const { captions, runtimeMs, film } = runFilm();
  const shots = [...new Set(captions)];
  assert.equal(shots.length, 10, `expected 10 shots, saw ${shots.length}`);
  assert.match(shots[0], /most fragmented database/, 'it opens on the fragmentation');
  assert.match(shots[4], /built the opposite/, 'the turn lands in the middle');
  assert.match(shots[8], /sovereign/i, 'the not-yet-sovereign beat is the ninth shot');
  assert.match(shots[9], /Own every layer/, 'it closes on the line');
  // A film nobody sits through is not a film: keep it around a minute.
  assert.ok(runtimeMs > 45_000 && runtimeMs < 90_000, `run time ${Math.round(runtimeMs / 1000)}s is outside 45–90s`);
  assert.equal(film.hidden, false, 'the stage holds its closing shot rather than vanishing');
});

test('reduced motion never starts the projector — the written cut stands alone', () => {
  const { captions, frames } = runFilm({ reduced: true });
  assert.equal(frames, 0, 'no animation frames may run under reduced motion');
  assert.equal(captions.length, 0, 'the caption layer is never driven');
});
