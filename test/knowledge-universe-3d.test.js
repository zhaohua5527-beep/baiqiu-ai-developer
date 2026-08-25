const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const source = fs.readFileSync(path.join(root, "renderer-v2", "knowledge-universe-3d.js"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer-v2", "knowledge-universe-3d.css"), "utf8");
const rendererCss = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("knowledge universe ships one local WebGL renderer with a DOM fallback", () => {
  assert.match(html, /id="knowledgeGraphCanvas"/);
  assert.match(html, /knowledge-universe-3d\.bundle\.js/);
  assert.match(source, /new ForceGraph3D\(element/);
  assert.match(source, /graph\.scene\(\)\.add\(this\.starfield\)/);
  assert.match(app, /data-renderer", "dom"/);
  assert.match(css, /data-renderer="webgl"/);
  assert.ok(fs.statSync(path.join(root, "renderer-v2", "knowledge-universe-3d.bundle.js")).size > 100_000);
});

test("static is the first-run default while preserving an explicit user choice", () => {
  assert.match(html, /data-knowledge-motion="static" aria-pressed="true"/);
  assert.match(app, /let knowledgeMotionMode = "static"/);
  assert.match(app, /settings\?\.knowledgeMotion === "dynamic" \? "dynamic" : "static"/);
  assert.match(source, /this\.motion = "static"/);
  assert.match(source, /this\.graph\.pauseAnimation\(\)/);
  assert.match(source, /this\.element\.addEventListener\("pointerdown", \(\) => this\.resumeFor/);
});

test("dynamic mode enables bounded visual effects and the knowledge interactions remain wired", () => {
  assert.match(source, /linkDirectionalParticles\(\(link\) => dynamic/);
  assert.match(source, /createAccretionMaterial/);
  assert.match(source, /makeStarfield\(this\.quality === "low" \? 420 : 900\)/);
  assert.match(source, /navigator\.hardwareConcurrency/);
  assert.match(source, /quality === "low" \? 96 : 240/);
  assert.match(source, /balancedKnowledgeSample/);
  assert.match(source, /onCategory\?\./);
  assert.match(source, /onNote\?\./);
  assert.match(source, /onSkill\?\./);
  assert.match(app, /onCategory: \(categoryId\) => selectKnowledgeCategory/);
  assert.match(app, /onNote: \(noteId\) => void selectKnowledgeObject/);
});

test("production build regenerates the offline 3D bundle", () => {
  assert.equal(pkg.devDependencies["3d-force-graph"], "^1.80.0");
  assert.equal(pkg.devDependencies.three, "^0.185.1");
  assert.match(pkg.scripts["build:knowledge-universe"], /esbuild renderer-v2\/knowledge-universe-3d\.js/);
  assert.match(pkg.scripts["prepare:integrity"], /build:knowledge-universe/);
});

test("knowledge universe wheel zoom stays bounded and does not stack camera tweens", () => {
  assert.match(app, /const KNOWLEDGE_ZOOM_MIN = 0\.72/);
  assert.match(app, /const KNOWLEDGE_ZOOM_MAX = 1\.32/);
  assert.match(app, /function queueKnowledgeUniverseWheelZoom/);
  assert.match(app, /window\.requestAnimationFrame/);
  assert.match(app, /setKnowledgeUniverseZoom\(knowledgeUniverseZoom \+ zoomDelta, \{ duration: 0 \}\)/);
  assert.match(app, /\{ passive: false, capture: true \}/);
  assert.match(source, /setZoom\(value, \{ duration = 220 \} = \{\}\)/);
  assert.match(source, /offset\.lengthSq\(\) < 1/);
});

test("knowledge universe command buttons keep horizontal blue silver white styling", () => {
  assert.match(rendererCss, /\.gantz-command-actions > button[\s\S]*?white-space: nowrap/);
  assert.match(rendererCss, /writing-mode: horizontal-tb/);
  assert.match(rendererCss, /word-break: keep-all/);
  assert.match(rendererCss, /background: var\(--gantz-blue\);[\s\S]*?color: #fff/);
});
