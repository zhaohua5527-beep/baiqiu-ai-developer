"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const { create, createStory } = require('../renderer-v2/mini-theatre');

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function fixture(reducedMotion = false) {
  const dom = load('<aside id="host"></aside>');
  const wrappers = new WeakMap();
  const listeners = new Map();
  const timers = new Map();
  let time = 10000;
  let nextTimer = 0;
  const document = {
    hidden: false,
    createElement: tag => wrap(dom(`<${tag}></${tag}>`)[0]),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); }
  };
  function wrap(node) {
    if (!node) return null;
    if (wrappers.has(node)) return wrappers.get(node);
    const element = {
      node, ownerDocument: document, dataset: {}, hidden: false,
      set className(value) { dom(node).attr('class', value); },
      set innerHTML(value) { dom(node).html(value); },
      set textContent(value) { dom(node).text(value); },
      get textContent() { return dom(node).text(); },
      setAttribute: (name, value) => dom(node).attr(name, value),
      querySelector: selector => wrap(dom(node).find(selector)[0]),
      replaceChildren: (...children) => { dom(node).empty(); for (const child of children) dom(node).append(child.node); },
      remove: () => dom(node).remove()
    };
    wrappers.set(node, element);
    return element;
  }
  const host = wrap(dom('#host')[0]);
  const theatre = create(host, {
    now: () => time, reducedMotion, random: seededRandom(1234),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  function advance(duration) {
    const end = time + duration;
    while (timers.size) {
      const item = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
      if (item[1].at > end) break;
      time = item[1].at;
      timers.delete(item[0]);
      item[1].callback();
    }
    time = end;
  }
  const start = (taskId = 'task', sessionId = 'session') => theatre.start({ taskId, sessionId, startedAt: time });
  return { theatre, host, dom, document, timers, listeners, advance, start };
}

test('one task owns one container and a continuous text story outlasts a minute', () => {
  const view = fixture();
  view.theatre.select('session');
  const node = view.start();
  assert.equal(view.start(), node);
  const seen = new Set([node.dataset.scene]);
  for (let index = 0; index < 360; index++) {
    view.advance(200);
    seen.add(node.dataset.scene);
    assert.equal(view.dom('.black-ball-mini-theatre').length, 1);
    assert.ok(view.timers.size <= 1);
  }
  assert.ok(seen.size >= 6);
  assert.ok(Number(node.dataset.beat) >= 9);
  assert.equal(view.dom('svg, canvas').length, 0);
  assert.equal(view.dom('.mt-actor').text(), '黑球');
  assert.ok(view.dom('.mt-target').text());
  assert.ok(view.dom('.mt-fx').text());
  assert.ok(view.dom('.mt-previous').text());
  assert.equal(node.querySelector('.mt-time').textContent, '72s');
  view.theatre.destroy();
  assert.equal(view.timers.size, 0);
  assert.equal(view.listeners.size, 0);
});

test('story branches retain the cast, object and place until an explicit next chapter', () => {
  const allowed = {
    opening: ['challenge', 'race', 'bargain'], challenge: ['win', 'stumble', 'dodge'],
    race: ['win', 'stumble'], bargain: ['alliance', 'trick'], win: ['truce'], stumble: ['recover'],
    recover: ['challenge', 'bargain'], dodge: ['challenge', 'bargain'], trick: ['race'],
    truce: ['travel'], alliance: ['travel'], travel: ['storm', 'gate', 'camp'],
    storm: ['rescue'], rescue: ['camp', 'gate'], gate: ['unlock', 'bounce'], bounce: ['unlock'],
    unlock: ['treasure'], treasure: ['opening'], camp: ['travel', 'visitor'], visitor: ['travel']
  };
  const seen = new Set();
  const story = createStory(seededRandom(42));
  let previous;
  for (let index = 0; index < 1000; index++) {
    const scene = story.next();
    seen.add(scene.id);
    assert.equal(scene.beat, index + 1);
    if (previous) {
      assert.ok(allowed[previous.id].includes(scene.id), `${previous.id} -> ${scene.id}`);
      if (scene.id !== 'opening') {
        assert.equal(scene.rival, previous.rival);
        assert.equal(scene.item, previous.item);
        assert.equal(scene.place, previous.place);
        assert.equal(scene.chapter, previous.chapter);
      } else {
        assert.equal(scene.chapter, previous.chapter + 1);
        assert.notEqual(scene.place, previous.place);
      }
    }
    assert.ok(scene.effect && scene.action);
    previous = scene;
  }
  assert.equal(seen.size, Object.keys(allowed).length);
  assert.ok(previous.chapter > 10);
});

test('different starts combine different casts, story openings and word effects', () => {
  const random = seededRandom(9719);
  const openings = new Set();
  const effects = new Set();
  let previousOpening = '';
  for (let index = 0; index < 100; index++) {
    const scene = createStory(random, previousOpening).next();
    assert.notEqual(scene.rival, previousOpening);
    previousOpening = scene.rival;
    openings.add(scene.before + scene.rival + scene.item);
    effects.add(scene.effect + scene.flourish);
  }
  assert.ok(openings.size > 90);
  assert.ok(effects.size > 15);
});

for (const outcome of ['success', 'failure', 'cancelled', 'waiting']) {
  test(`${outcome} freezes, preserves its last frame and releases every timer/listener`, () => {
    const view = fixture();
    view.theatre.select('session');
    const node = view.start();
    view.advance(12300);
    view.theatre.finish('task', outcome);
    assert.equal(node.dataset.outcome, outcome);
    view.advance(1600);
    assert.equal(node.dataset.state, 'FROZEN');
    const frozenScene = node.dataset.scene;
    const frozenTime = node.querySelector('.mt-time').textContent;
    view.advance(60000);
    assert.equal(node.dataset.scene, frozenScene);
    assert.equal(node.querySelector('.mt-time').textContent, frozenTime);
    assert.equal(view.timers.size, 0);
    assert.equal(view.listeners.size, 0);
    view.theatre.finish('task', 'failure');
    assert.equal(node.dataset.outcome, outcome);
    assert.equal(view.dom('.black-ball-mini-theatre').length, 1);
  });
}

test('switching sessions pauses offscreen animation without resetting elapsed task time', () => {
  const view = fixture();
  view.theatre.select('session');
  const node = view.start();
  view.advance(2000);
  view.theatre.select('other');
  assert.equal(view.host.hidden, true);
  assert.equal(view.timers.size, 0);
  view.advance(20000);
  view.theatre.select('session');
  assert.equal(view.dom('.black-ball-mini-theatre').length, 1);
  assert.equal(node.querySelector('.mt-time').textContent, '22s');
  view.document.hidden = true;
  view.listeners.get('visibilitychange')();
  assert.equal(view.timers.size, 0);
  view.theatre.finish('task', 'success');
  assert.equal(node.dataset.state, 'FROZEN');
  assert.equal(view.listeners.size, 0);
});

test('hidden ending freezes and a later task cannot inherit old animation state', () => {
  const view = fixture();
  view.theatre.select('session');
  const first = view.start();
  view.theatre.finish('task', 'cancelled');
  view.document.hidden = true;
  view.listeners.get('visibilitychange')();
  assert.equal(view.timers.size, 0);
  assert.equal(view.listeners.size, 0);
  view.document.hidden = false;
  const second = view.start('new');
  assert.notEqual(second, first);
  assert.equal(second.dataset.state, 'RUNNING');
  assert.equal(view.dom('.black-ball-mini-theatre').length, 1);
  view.theatre.destroy();
  view.advance(5000);
  assert.equal(view.timers.size, 0);
  assert.equal(view.dom('.black-ball-mini-theatre').length, 0);
});

test('reduced motion preserves scenes and ends without an animation timer', () => {
  const view = fixture(true);
  view.theatre.select('session');
  const node = view.start();
  assert.equal(node.dataset.reduced, '1');
  view.theatre.finish('task', 'success');
  assert.equal(node.dataset.state, 'FROZEN');
  assert.equal(view.timers.size, 0);
});

test('background completion survives unrelated session rendering and returns as a frozen frame', () => {
  const view = fixture();
  view.theatre.select('session');
  const node = view.start();
  view.theatre.select('other');
  view.advance(2500);
  view.theatre.finish('task', 'success');
  view.theatre.select('other');
  assert.equal(view.timers.size, 0);
  assert.equal(view.listeners.size, 0);
  view.theatre.select('session');
  assert.equal(view.host.hidden, false);
  assert.equal(node.dataset.state, 'FROZEN');
  assert.equal(node.dataset.outcome, 'success');
  assert.equal(view.dom('.black-ball-mini-theatre').length, 1);
  assert.equal(view.timers.size, 0);
});

test('leaving during the closing animation releases the ending timer and listener', () => {
  const view = fixture();
  view.theatre.select('session');
  const node = view.start();
  view.theatre.finish('task', 'success');
  view.theatre.select('other');
  assert.equal(node.dataset.state, 'FROZEN');
  assert.equal(view.timers.size, 0);
  assert.equal(view.listeners.size, 0);
  view.theatre.select('session');
  assert.equal(node.dataset.state, 'FROZEN');
});

test('theatre is outside message scrolling and has no model, storage or execution-event dependency', () => {
  const root = path.join(__dirname, '..');
  const moduleSource = fs.readFileSync(path.join(root, 'renderer-v2/mini-theatre.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer-v2/app.js'), 'utf8');
  const html = load(fs.readFileSync(path.join(root, 'renderer-v2/index.html'), 'utf8'));
  assert.equal(html('#miniTheatreHost').parent().hasClass('chat'), true);
  assert.equal(html('#messageList #miniTheatreHost').length, 0);
  assert.ok(html('#miniTheatreHost').index() < html('#conversationStage').index());
  assert.doesNotMatch(moduleSource, /fetch\(|api\.|ipc|localStorage|sessionStorage|MutationObserver|ResizeObserver|appendMessage|dispatchEvent/);
  assert.doesNotMatch(app, /function scheduleExecutionActivityWhimsy\(/);
  const start = app.indexOf('function streamActivityHtml(');
  const end = app.indexOf('function updateLiveStreamElapsed(', start);
  assert.doesNotMatch(app.slice(start, end), /mini-theatre-region|小剧场/);
  assert.match(app, /miniTheatre\.start\(\{ taskId: streamId, sessionId, startedAt: entry\.startedAt \}\)/);
  assert.match(app, /miniTheatre\.select\(resolvedSessionId\)/);
});
