import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";

const CORE_ID = "__knowledge_core__";
const CATEGORY_PREFIX = "category:";
const OBJECT_PREFIX = "object:";
const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.32;
const CATEGORY_COLORS = [
  "#f0b35c",
  "#6fc7b2",
  "#e78478",
  "#a8b8d8",
  "#d5cb72",
  "#bd8fc4",
  "#79b7c6",
  "#d59b72"
];

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function hashText(value = "") {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cssColor(element, name, fallback) {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

function createGlowTexture(innerColor = "rgba(255,222,164,.82)") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 124);
  gradient.addColorStop(0, "rgba(255,255,255,.95)");
  gradient.addColorStop(.08, innerColor);
  gradient.addColorStop(.34, "rgba(238,167,89,.2)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createTextSprite(text, color, scale = 1) {
  const label = String(text || "").trim();
  if (!label) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = "600 30px 'Microsoft YaHei UI', sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.shadowColor = "rgba(0,0,0,.92)";
  context.shadowBlur = 12;
  context.lineWidth = 7;
  context.strokeStyle = "rgba(3,6,9,.86)";
  const fitted = label.length > 18 ? `${label.slice(0, 17)}...` : label;
  context.strokeText(fitted, 256, 56);
  context.fillStyle = color;
  context.fillText(fitted, 256, 56);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(78 * scale, 17 * scale, 1);
  sprite.userData.texture = texture;
  return sprite;
}

function createAccretionMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMotion: { value: 0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uMotion;
      void main() {
        vec2 p = vUv - .5;
        float angle = atan(p.y, p.x);
        float radius = length(p) * 2.0;
        float flow = sin(angle * 7.0 - uTime * (1.1 + uMotion) + radius * 21.0) * .5 + .5;
        float band = smoothstep(.98, .58, radius) * smoothstep(.18, .45, radius);
        vec3 amber = vec3(1.0, .48, .14);
        vec3 pearl = vec3(1.0, .91, .68);
        vec3 teal = vec3(.18, .66, .63);
        vec3 color = mix(amber, pearl, flow);
        color = mix(color, teal, smoothstep(.78, 1.0, radius) * .34);
        float alpha = band * (.2 + flow * .68) * (1.0 - smoothstep(.78, 1.0, radius));
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });
}

function createCoreObject() {
  const group = new THREE.Group();
  group.name = "knowledge-black-core";

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: createGlowTexture(),
    color: 0xffbd72,
    opacity: .64,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  }));
  glow.scale.set(142, 142, 1);
  group.add(glow);

  const accretionMaterial = createAccretionMaterial();
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(132, 132, 1, 1), accretionMaterial);
  disc.rotation.x = Math.PI * .42;
  disc.rotation.z = -.2;
  disc.renderOrder = 1;
  group.add(disc);

  const outerRing = new THREE.Mesh(
    new THREE.TorusGeometry(47, .55, 8, 128),
    new THREE.MeshBasicMaterial({ color: 0x5bb9ac, transparent: true, opacity: .42, blending: THREE.AdditiveBlending })
  );
  outerRing.rotation.x = Math.PI * .42;
  outerRing.rotation.z = -.2;
  group.add(outerRing);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(22, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0x010203, roughness: .94, metalness: .16 })
  );
  sphere.renderOrder = 3;
  group.add(sphere);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(23.4, 1.1, 12, 96),
    new THREE.MeshBasicMaterial({ color: 0xffc982, transparent: true, opacity: .78, blending: THREE.AdditiveBlending })
  );
  rim.rotation.x = Math.PI / 2;
  rim.renderOrder = 4;
  group.add(rim);

  const label = createTextSprite("WHITEBALL / KNOWLEDGE CORE", "#f7e5c4", .82);
  if (label) {
    label.position.set(0, -43, 0);
    group.add(label);
  }

  group.userData.animation = { disc, outerRing, rim, glow, accretionMaterial };
  return group;
}

function createKnowledgeObject(node) {
  if (node.kind === "core") return createCoreObject();
  const group = new THREE.Group();
  const color = new THREE.Color(node.color || "#f0b35c");
  const selected = Boolean(node.selected);
  const category = node.kind === "category";
  const skill = node.kind === "skill";
  const radius = category ? 7.2 : skill ? 5.4 : 4.2 + Math.min(3, finite(node.level, 1) * .34);
  const geometry = category
    ? new THREE.IcosahedronGeometry(radius, 2)
    : skill
      ? new THREE.OctahedronGeometry(radius, 1)
      : new THREE.SphereGeometry(radius, 22, 16);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: selected ? 1.05 : category ? .52 : .3,
    roughness: category ? .38 : .58,
    metalness: category ? .36 : .12,
    transparent: true,
    opacity: node.dimmed ? .28 : .96
  }));
  group.add(mesh);

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 1.5, selected ? .42 : .16, 7, 54),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: node.dimmed ? .08 : selected ? .92 : category ? .4 : .18,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  halo.rotation.x = Math.PI * .58;
  halo.rotation.z = (hashText(node.id) % 100) / 90;
  group.add(halo);

  if (category || selected) {
    const label = createTextSprite(node.label, selected ? "#fff2d2" : "#d9e2df", category ? .9 : .78);
    if (label) {
      label.position.set(0, -(radius + 10), 0);
      group.add(label);
    }
  }
  group.userData.animation = { halo, mesh, phase: (hashText(node.id) % 360) * Math.PI / 180 };
  return group;
}

function makeStarfield(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [new THREE.Color("#f7ead2"), new THREE.Color("#8bc9bd"), new THREE.Color("#d4a6a0")];
  for (let index = 0; index < count; index += 1) {
    const radius = 250 + Math.random() * 480;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos((Math.random() * 2) - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi) * .65;
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    const color = palette[index % palette.length];
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.25,
    sizeAttenuation: true,
    transparent: true,
    opacity: .54,
    vertexColors: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  points.name = "knowledge-starfield";
  return points;
}

function normalizedTags(item) {
  return Array.isArray(item?.tags)
    ? item.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
}

function balancedKnowledgeSample(items, limit) {
  if (items.length <= limit) return items.slice();
  const buckets = new Map();
  for (const item of items) {
    const category = String(item?.category || "inbox");
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(item);
  }
  const groups = [...buckets.values()];
  const indexes = new Array(groups.length).fill(0);
  const sampled = [];
  while (sampled.length < limit) {
    let added = false;
    for (let groupIndex = 0; groupIndex < groups.length && sampled.length < limit; groupIndex += 1) {
      const item = groups[groupIndex][indexes[groupIndex]];
      if (!item) continue;
      sampled.push(item);
      indexes[groupIndex] += 1;
      added = true;
    }
    if (!added) break;
  }
  return sampled;
}

function buildGraphData(items = [], categories = [], selection = {}, quality = "high") {
  const visibleLimit = quality === "low" ? 96 : 240;
  const visibleItems = balancedKnowledgeSample(items, visibleLimit);
  const categoryMap = new Map();
  for (const category of categories) {
    if (!category?.id || category.id === "all") continue;
    categoryMap.set(String(category.id), { ...category });
  }
  for (const item of visibleItems) {
    const id = String(item?.category || "inbox");
    if (!categoryMap.has(id)) categoryMap.set(id, { id, label: id, count: 0 });
  }
  if (!categoryMap.size) categoryMap.set("inbox", { id: "inbox", label: "待整理", count: visibleItems.length });

  const categoryList = [...categoryMap.values()];
  const nodes = [{ id: CORE_ID, kind: "core", label: "知识核心", fx: 0, fy: 0, fz: 0 }];
  const links = [];
  const coordinates = new Map();
  categoryList.forEach((category, index) => {
    const angle = (index / Math.max(1, categoryList.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = 118 + (index % 2) * 18;
    const coordinate = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * .68,
      z: Math.sin(angle * 2.1) * 34
    };
    coordinates.set(String(category.id), coordinate);
    const color = CATEGORY_COLORS[index % CATEGORY_COLORS.length];
    nodes.push({
      id: `${CATEGORY_PREFIX}${category.id}`,
      categoryId: String(category.id),
      kind: "category",
      label: category.label || category.id,
      color,
      selected: selection.category === category.id,
      fx: coordinate.x,
      fy: coordinate.y,
      fz: coordinate.z
    });
    links.push({ source: CORE_ID, target: `${CATEGORY_PREFIX}${category.id}`, kind: "domain", color });
  });

  const categoryIndexes = new Map();
  const itemNodes = [];
  visibleItems.forEach((item, index) => {
    const categoryId = String(item?.category || "inbox");
    const categoryIndex = Math.max(0, categoryList.findIndex((category) => String(category.id) === categoryId));
    const base = coordinates.get(categoryId) || { x: 0, y: 0, z: 0 };
    const localIndex = categoryIndexes.get(categoryId) || 0;
    categoryIndexes.set(categoryId, localIndex + 1);
    const angle = ((hashText(item.id || item.title || index) % 360) * Math.PI / 180) + localIndex * 1.91;
    const distance = 31 + (localIndex % 4) * 11;
    const id = `${OBJECT_PREFIX}${item.id || index}`;
    const isSkill = item.kind === "skill";
    const selected = isSkill ? selection.skill === item.id : selection.note === item.id;
    const node = {
      id,
      objectId: String(item.id || ""),
      kind: isSkill ? "skill" : "note",
      categoryId,
      label: item.title || "未命名知识",
      detail: isSkill ? (item.statusLabel || item.status || "技能") : (item.typeLabel || item.statusLabel || "知识记录"),
      tags: normalizedTags(item),
      level: finite(item.level, isSkill ? 4 : 1),
      color: CATEGORY_COLORS[categoryIndex % CATEGORY_COLORS.length],
      selected,
      fx: base.x + Math.cos(angle) * distance,
      fy: base.y + Math.sin(angle) * distance * .72,
      fz: base.z + Math.sin(angle * 1.7) * (18 + localIndex % 3 * 6)
    };
    itemNodes.push(node);
    nodes.push(node);
    links.push({ source: `${CATEGORY_PREFIX}${categoryId}`, target: id, kind: "knowledge", color: node.color });
  });

  let associationCount = 0;
  for (let left = 0; left < itemNodes.length && associationCount < 36; left += 1) {
    const tags = new Set(itemNodes[left].tags);
    if (!tags.size) continue;
    for (let right = left + 1; right < itemNodes.length && associationCount < 36; right += 1) {
      if (!itemNodes[right].tags.some((tag) => tags.has(tag))) continue;
      links.push({ source: itemNodes[left].id, target: itemNodes[right].id, kind: "association", color: "#aeb8b6" });
      associationCount += 1;
    }
  }
  return { nodes, links };
}

class KnowledgeUniverse3D {
  constructor(element, callbacks = {}) {
    this.element = element;
    this.callbacks = callbacks;
    this.motion = "static";
    this.visible = false;
    this.zoom = 1;
    this.animationFrame = 0;
    this.drawFrame = 0;
    this.pauseTimer = 0;
    this.quality = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 ? "low" : "high";
    this.graph = new ForceGraph3D(element, {
      controlType: "orbit",
      rendererConfig: {
        alpha: true,
        antialias: this.quality !== "low",
        powerPreference: "high-performance"
      }
    });
    this.configure();
  }

  configure() {
    const graph = this.graph;
    graph
      .backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .nodeLabel((node) => node.kind === "core" ? "知识核心" : `<strong>${node.label}</strong>${node.detail ? `<br>${node.detail}` : ""}`)
      .nodeThreeObject((node) => createKnowledgeObject(node))
      .linkColor((link) => link.color || "#aeb8b6")
      .linkOpacity(.24)
      .linkWidth((link) => link.kind === "domain" ? 1.15 : link.kind === "association" ? .24 : .48)
      .linkDirectionalParticleColor((link) => link.color || "#f0b35c")
      .linkDirectionalParticleWidth((link) => link.kind === "domain" ? 1.7 : .9)
      .linkDirectionalParticleSpeed(.004)
      .linkDirectionalParticles(0)
      .enableNodeDrag(false)
      .enableNavigationControls(true)
      .cooldownTicks(1)
      .warmupTicks(0)
      .onNodeClick((node) => this.selectNode(node))
      .onNodeHover((node) => {
        this.element.dataset.hover = node ? "true" : "false";
      });

    graph.lights([
      new THREE.AmbientLight(0xdce5df, 1.22),
      new THREE.DirectionalLight(0xffd29a, 1.65),
      new THREE.PointLight(0x62c0b1, 2.2, 360)
    ]);
    graph.lights()[1].position.set(110, 90, 170);
    graph.lights()[2].position.set(-90, -40, 90);

    const renderer = graph.renderer();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === "low" ? 1 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .82;

    const controls = graph.controls();
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.rotateSpeed = .48;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minDistance = 145;
    controls.maxDistance = 720;

    this.starfield = makeStarfield(this.quality === "low" ? 420 : 900);
    graph.scene().add(this.starfield);
    graph.cameraPosition({ x: 0, y: 36, z: 410 }, { x: 0, y: 0, z: 0 });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.element);
    this.element.addEventListener("pointerdown", () => this.resumeFor(900));
    this.element.addEventListener("wheel", () => this.resumeFor(900), { passive: true });
    this.resize();
    this.element.dataset.state = "ready";
    this.resumeFor(900);
  }

  resize() {
    const bounds = this.element.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) return;
    this.graph.width(Math.round(bounds.width)).height(Math.round(bounds.height));
    this.resumeFor(240);
  }

  setData({ items = [], categories = [], selectedCategory = "all", selectedNoteId = "", selectedSkillId = "" } = {}) {
    const data = buildGraphData(items, categories, {
      category: selectedCategory,
      note: selectedNoteId,
      skill: selectedSkillId
    }, this.quality);
    const firstData = !this.hasData;
    this.graph.graphData(data);
    this.hasData = true;
    if (firstData) this.resetView(0);
    this.applyMotion();
    this.resumeFor(700);
  }

  setMotion(mode) {
    this.motion = mode === "dynamic" && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "dynamic" : "static";
    this.applyMotion();
  }

  applyMotion() {
    const dynamic = this.motion === "dynamic" && this.visible;
    this.graph
      .linkDirectionalParticles((link) => dynamic && link.kind !== "association" ? (link.kind === "domain" ? 3 : 1) : 0)
      .refresh();
    if (dynamic) {
      clearTimeout(this.pauseTimer);
      this.graph.resumeAnimation();
      this.startAnimation();
    } else {
      this.stopAnimation();
      this.resumeFor(240);
    }
  }

  startAnimation() {
    if (this.animationFrame || !this.visible || this.motion !== "dynamic") return;
    const animate = (time) => {
      if (!this.visible || this.motion !== "dynamic") {
        this.animationFrame = 0;
        return;
      }
      const seconds = time / 1000;
      if (this.starfield) {
        this.starfield.rotation.y = seconds * .006;
        this.starfield.rotation.z = Math.sin(seconds * .035) * .035;
      }
      this.graph.scene().traverse((object) => {
        const animation = object.userData?.animation;
        if (!animation) return;
        if (animation.accretionMaterial) {
          animation.accretionMaterial.uniforms.uTime.value = seconds;
          animation.accretionMaterial.uniforms.uMotion.value = 1;
          animation.outerRing.rotation.z = seconds * .12;
          animation.rim.rotation.z = -seconds * .18;
          animation.glow.material.opacity = .58 + Math.sin(seconds * 1.4) * .08;
        } else if (animation.halo) {
          animation.halo.rotation.z = animation.phase + seconds * .16;
          const pulse = 1 + Math.sin(seconds * 1.1 + animation.phase) * .035;
          animation.mesh.scale.setScalar(pulse);
        }
      });
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  stopAnimation() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  resumeFor(duration = 500) {
    if (!this.visible || this.motion === "dynamic") return;
    clearTimeout(this.pauseTimer);
    this.graph.resumeAnimation();
    this.pauseTimer = setTimeout(() => {
      if (this.visible && this.motion === "static") this.graph.pauseAnimation();
    }, duration);
  }

  setVisible(visible) {
    const wasVisible = this.visible;
    this.visible = Boolean(visible);
    if (!this.visible) {
      clearTimeout(this.pauseTimer);
      this.stopAnimation();
      this.graph.pauseAnimation();
      return;
    }
    this.resize();
    if (!wasVisible) this.resetView(420);
    this.applyMotion();
  }

  resetView(duration = 420) {
    this.zoom = 1;
    const target = { x: 0, y: 0, z: 0 };
    const controls = this.graph.controls();
    if (controls?.target?.set) controls.target.set(0, 0, 0);
    this.graph.cameraPosition({ x: 0, y: 36, z: 410 }, target, duration);
    this.resumeFor(duration + 180);
  }

  setZoom(value, { duration = 220 } = {}) {
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, finite(value, 1)));
    const controls = this.graph.controls();
    const target = controls.target || new THREE.Vector3(0, 0, 0);
    const camera = this.graph.camera();
    const offset = camera.position.clone().sub(target);
    if (!Number.isFinite(offset.lengthSq()) || offset.lengthSq() < 1) offset.set(0, 36, 410);
    const factor = this.zoom / nextZoom;
    offset.multiplyScalar(factor);
    const distance = Math.max(145, Math.min(720, offset.length()));
    offset.setLength(distance);
    this.zoom = nextZoom;
    this.graph.cameraPosition({
      x: target.x + offset.x,
      y: target.y + offset.y,
      z: target.z + offset.z
    }, target, Math.max(0, finite(duration, 220)));
    this.resumeFor(Math.max(180, finite(duration, 220) + 140));
  }

  focusNode(node, duration = 720) {
    if (!node || !Number.isFinite(node.x) || node.kind === "core") {
      this.graph.cameraPosition({ x: 0, y: 34, z: 360 / this.zoom }, { x: 0, y: 0, z: 0 }, duration);
      this.resumeFor(duration + 180);
      return;
    }
    const target = { x: node.x, y: node.y, z: node.z };
    const direction = new THREE.Vector3(node.x, node.y, node.z);
    if (direction.lengthSq() < 1) direction.set(0, 0, 1);
    direction.normalize().multiplyScalar(node.kind === "category" ? 92 : 62);
    this.graph.cameraPosition({
      x: node.x + direction.x,
      y: node.y + direction.y + 12,
      z: node.z + direction.z
    }, target, duration);
    this.resumeFor(duration + 180);
  }

  selectNode(node) {
    this.focusNode(node);
    if (node.kind === "category") this.callbacks.onCategory?.(node.categoryId);
    if (node.kind === "note") this.callbacks.onNote?.(node.objectId);
    if (node.kind === "skill") this.callbacks.onSkill?.(node.objectId);
    if (node.kind === "core") this.callbacks.onCore?.();
  }

  destroy() {
    clearTimeout(this.pauseTimer);
    this.stopAnimation();
    this.resizeObserver?.disconnect();
    this.graph?._destructor?.();
    this.element.dataset.state = "destroyed";
  }
}

class LightParticleUniverse {
  constructor(element, callbacks = {}) {
    this.element = element;
    this.callbacks = callbacks;
    this.motion = "static";
    this.visible = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.particles = [];
    this.events = [];
    this.selected = null;
    this.revealedParticleId = "";
    this.gatherStarted = 0;
    this.gatherRelease = 0;
    this.dragTarget = null;
    this.pointer = { x: -1000, y: -1000, active: false };
    this.pressTimer = 0;
    this.pressed = null;
    this.grabbed = false;
    this.moved = false;
    this.animationFrame = 0;
    this.wakeUntil = 0;
    this.now = performance.now();
    this.lastFrame = 0;
    this.quality = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 ? "low" : "high";
    this.frameInterval = this.quality === "low" ? 40 : 30;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "knowledge-light-particle-canvas";
    this.canvas.setAttribute("aria-label", "光粒子知识空间");
    this.canvas.style.touchAction = "none";
    this.element.replaceChildren(this.canvas);
    this.context = this.canvas.getContext("2d");
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.element);
    this.resize();
    this.element.dataset.state = "ready";
  }

  resize() {
    const bounds = this.element.getBoundingClientRect();
    if (bounds.width < 2 || bounds.height < 2) return;
    this.width = Math.round(bounds.width);
    this.height = Math.round(bounds.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality === "low" ? 1 : 1.5);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  setData({ items = [], categories = [], selectedCategory = "all", selectedNoteId = "", selectedSkillId = "" } = {}) {
    const categoryIds = categories.map((category) => String(category.id || "inbox"));
    const categoryIndex = new Map(categoryIds.map((id, index) => [id, index]));
    const visibleLimit = this.quality === "low" ? 90 : 160;
    const sourceItems = Array.isArray(items) ? items.slice(0, visibleLimit) : [];
    const particles = [];

    sourceItems.forEach((item, index) => {
      const categoryId = String(item?.category || "inbox");
      const cluster = categoryIndex.has(categoryId) ? categoryIndex.get(categoryId) : index % Math.max(1, categoryIds.length || 5);
      const seed = hashText(item?.id || item?.title || index);
      const angle = ((seed % 360) * Math.PI) / 180;
      const radius = .045 + ((seed >>> 8) % 100) / 1000;
      const center = this.clusterCenter(cluster, Math.max(1, categoryIds.length || 5));
      const x = center.x + Math.cos(angle) * radius * (1.2 + ((seed >>> 16) % 40) / 100);
      const y = center.y + Math.sin(angle) * radius * .72;
      particles.push(this.createParticle({
        id: String(item?.id || `item-${index}`),
        x,
        y,
        cluster,
        kind: item?.kind === "skill" ? "skill" : "note",
        categoryId,
        label: item?.title || "未命名知识",
        selected: item?.kind === "skill" ? String(item?.id || "") === String(selectedSkillId) : String(item?.id || "") === String(selectedNoteId),
        seed
      }));
    });

    const ambientCount = Math.max(55, Math.min(this.quality === "low" ? 80 : 120, sourceItems.length || 90));
    for (let index = 0; index < ambientCount; index += 1) {
      const seed = hashText(`ambient-${index}`);
      const cluster = index % Math.max(1, categoryIds.length || 5);
      const center = this.clusterCenter(cluster, Math.max(1, categoryIds.length || 5));
      const angle = ((seed % 360) * Math.PI) / 180;
      const radius = .035 + ((seed >>> 9) % 100) / 860;
      particles.push(this.createParticle({
        id: `ambient-${index}`,
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * .72,
        cluster,
        kind: "ambient",
        categoryId: categoryIds[cluster] || "inbox",
        label: "",
        selected: false,
        seed
      }));
    }

    this.particles = particles;
    this.selected = particles.find((particle) => particle.selected) || null;
    this.gatherStarted = this.selected ? this.now : 0;
    this.gatherRelease = 0;
    this.draw();
    this.applyMotion();
  }

  clusterCenter(index, total) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
    const radius = total <= 3 ? .17 : .24;
    return { x: .5 + Math.cos(angle) * radius, y: .5 + Math.sin(angle) * radius * .72 };
  }

  createParticle({ id, x, y, cluster, kind, categoryId, label, selected, seed }) {
    return {
      id,
      x,
      y,
      homeX: x,
      homeY: y,
      cluster,
      kind,
      categoryId,
      label,
      selected,
      size: kind === "ambient" ? .55 + (seed % 8) / 12 : 1.05 + (seed % 9) / 7,
      brightness: kind === "ambient" ? .12 + (seed % 10) / 42 : .34 + (seed % 11) / 23,
      pulse: (seed % 100) / 100 * Math.PI * 2,
      drift: .0002 + (seed % 7) * .000035,
      phase: (seed % 360) * Math.PI / 180
    };
  }

  setMotion(mode) {
    const next = mode === "dynamic" ? "dynamic" : "static";
    this.motion = next;
    this.element.dataset.motion = next;
    this.canvas.dataset.motion = next;
    this.now = performance.now();
    this.lastFrame = 0;
    this.pointer.active = false;
    this.wakeUntil = this.now;
    if (next === "static") {
      this.grabbed = false;
      this.dragTarget = null;
      this.gatherRelease = 0;
      this.events = [];
      clearTimeout(this.pressTimer);
      this.stopAnimation();
      this.particles.forEach((particle) => {
        particle.x = particle.homeX;
        particle.y = particle.homeY;
      });
      this.draw();
      return;
    }
    if (this.selected) this.gatherStarted = this.now;
    this.startAnimation();
  }

  applyMotion() {
    if (this.motion === "dynamic" && this.visible) {
      this.startAnimation();
    } else {
      this.stopAnimation();
    }
    this.draw();
  }

  startAnimation() {
    if (this.animationFrame || !this.visible) return;
    const animate = (time) => {
      if (!this.visible || (this.motion !== "dynamic" && time >= this.wakeUntil && !this.grabbed)) {
        this.animationFrame = 0;
        this.lastFrame = 0;
        this.draw();
        return;
      }
      if (this.lastFrame && time - this.lastFrame < this.frameInterval) {
        this.animationFrame = requestAnimationFrame(animate);
        return;
      }
      const delta = this.lastFrame ? Math.min(50, time - this.lastFrame) : this.frameInterval;
      this.lastFrame = time;
      this.now = time;
      this.update(delta);
      this.draw();
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  stopAnimation() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.lastFrame = 0;
  }

  wakeFor(duration = 900) {
    if (this.motion !== "dynamic") {
      this.draw();
      return;
    }
    this.wakeUntil = Math.max(this.wakeUntil, this.now + duration);
    if (this.visible) this.startAnimation();
  }

  update(delta) {
    const selected = this.selected;
    const gatherIn = selected ? Math.min(1, Math.max(0, (this.now - this.gatherStarted) / 1200)) : 0;
    const gatherEase = gatherIn * gatherIn * (3 - 2 * gatherIn);
    const gatherOut = this.gatherRelease ? Math.max(0, 1 - (this.now - this.gatherRelease) / 1500) : 1;
    const gatherStrength = gatherEase * gatherOut;
    this.particles.forEach((particle) => {
      const isSelected = particle === selected;
      const related = selected && particle.cluster === selected.cluster;
      let targetX = particle.homeX + Math.sin(this.now * particle.drift + particle.phase) * .008;
      let targetY = particle.homeY + Math.cos(this.now * particle.drift * .82 + particle.phase) * .0055;
      if (related && !isSelected) {
        const offsetX = particle.homeX - selected.homeX;
        const offsetY = particle.homeY - selected.homeY;
        const scale = 1 - gatherStrength * .58;
        targetX = selected.x + offsetX * scale;
        targetY = selected.y + offsetY * scale;
      }
      if (this.grabbed && related && !isSelected) {
        const orbit = (particle.id.length % 7) * .9 + this.now * .0007;
        targetX = selected.x + Math.cos(orbit) * .012;
        targetY = selected.y + Math.sin(orbit) * .008;
      }
      if (isSelected && this.dragTarget) {
        targetX = this.dragTarget.x;
        targetY = this.dragTarget.y;
      }
      if (this.pointer.active) {
        const point = this.toScreen(particle);
        const distance = Math.hypot(point.x - this.pointer.x, point.y - this.pointer.y);
        if (distance < 150) {
          targetX += ((point.x - this.pointer.x) / Math.max(1, this.width)) * .008;
          targetY += ((point.y - this.pointer.y) / Math.max(1, this.height)) * .008;
        }
      }
      const tau = isSelected && this.grabbed ? 180 : related ? 900 : 2200;
      const factor = 1 - Math.exp(-delta / tau);
      particle.x += (targetX - particle.x) * factor;
      particle.y += (targetY - particle.y) * factor;
    });
    this.events = this.events.filter((event) => this.now - event.started < event.life);
  }

  toScreen(particle) {
    return {
      x: (particle.x - .5) * this.width * this.zoom + this.width / 2 + this.panX,
      y: (particle.y - .5) * this.height * this.zoom + this.height / 2 + this.panY
    };
  }

  draw() {
    if (!this.context || !this.width || !this.height) return;
    const context = this.context;
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = "#030914";
    context.fillRect(0, 0, this.width, this.height);
    const isLight = false;
    const haze = context.createRadialGradient(this.width * .5, this.height * .5, 0, this.width * .5, this.height * .5, this.width * .6);
    haze.addColorStop(0, isLight ? "rgba(66,139,225,.05)" : "rgba(43,120,219,.16)");
    haze.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = haze;
    context.fillRect(0, 0, this.width, this.height);
    context.save();
    context.fillStyle = "rgba(158,207,255,.26)";
    for (let index = 0; index < 72; index += 1) {
      const seed = hashText(`space-star-${index}`);
      const x = (seed % 1000) / 1000 * this.width;
      const y = ((seed >>> 8) % 1000) / 1000 * this.height;
      const size = index % 13 === 0 ? 1.2 : .55;
      context.globalAlpha = .18 + ((seed >>> 16) % 40) / 100;
      context.fillRect(x, y, size, size);
    }
    context.restore();
    this.drawEvents(context);
    this.particles.forEach((particle) => this.drawParticle(context, particle));
    if (this.selected && this.revealedParticleId === this.selected.id) {
      this.drawSelectedLabel(context, this.selected);
    }
  }

  drawEvents(context) {
    context.save();
    context.globalCompositeOperation = "screen";
    this.events.forEach((event) => {
      const progress = Math.max(0, Math.min(1, (this.now - event.started) / event.life));
      const fade = progress < .18 ? progress / .18 : 1 - (progress - .18) / .82;
      const from = this.toScreen(event.from);
      const to = this.toScreen(event.to);
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2 - 12 * Math.sin(progress * Math.PI);
      context.strokeStyle = `rgba(92,170,255,${Math.max(0, fade) * .38})`;
      context.lineWidth = 1;
      context.shadowColor = "rgba(81,160,255,.8)";
      context.shadowBlur = 7;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.quadraticCurveTo(midX, midY, to.x, to.y);
      context.stroke();
    });
    context.restore();
  }

  drawParticle(context, particle) {
    const point = this.toScreen(particle);
    const selected = particle === this.selected;
    const related = this.selected && particle.cluster === this.selected.cluster;
    const distance = this.pointer.active ? Math.hypot(point.x - this.pointer.x, point.y - this.pointer.y) : 9999;
    const nearby = Math.max(0, 1 - distance / 150);
    const dim = this.selected && !selected && !related ? .42 : 1;
    const breath = this.motion === "dynamic"
      ? .8 + Math.sin(this.now * particle.drift * 2 + particle.pulse) * .2
      : 1;
    const brightness = Math.min(1.6, (particle.brightness + nearby * .62 + (selected ? 1.1 : 0) + (related ? .12 : 0)) * breath * dim);
    const size = particle.size * (1 + nearby * .28 + (selected ? 1.15 : 0));
    context.save();
    context.globalCompositeOperation = "screen";
    const persistentGlow = particle.kind !== "ambient" && brightness > .9 && particle.pulse > 5;
    if (selected || nearby > .18 || persistentGlow) {
      const glowRadius = size * (selected ? 7 : 3.6);
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, glowRadius);
      glow.addColorStop(0, `rgba(222,244,255,${Math.min(.58, brightness * .42)})`);
      glow.addColorStop(.28, `rgba(83,164,255,${Math.min(.22, brightness * .16)})`);
      glow.addColorStop(1, "rgba(35,111,211,0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = `rgba(${selected ? "242,252,255" : "174,222,255"},${Math.min(1, brightness + .16)})`;
    context.beginPath();
    context.arc(point.x, point.y, Math.max(.65, size * .56), 0, Math.PI * 2);
    context.fill();
    if (selected) {
      context.strokeStyle = "rgba(211,241,255,.78)";
      context.lineWidth = .7;
      context.beginPath();
      context.moveTo(point.x - size * 4, point.y);
      context.lineTo(point.x + size * 4, point.y);
      context.moveTo(point.x, point.y - size * 4);
      context.lineTo(point.x, point.y + size * 4);
      context.stroke();
    }
    context.restore();
  }

  drawSelectedLabel(context, particle) {
    const point = this.toScreen(particle);
    const side = point.x > this.width * .62 ? -1 : 1;
    const x = point.x + side * 24;
    context.save();
    context.textAlign = side === 1 ? "left" : "right";
    context.font = "500 13px 'Microsoft YaHei UI', sans-serif";
    context.fillStyle = "#2f8df4";
    context.shadowColor = "rgba(81,159,255,.64)";
    context.shadowBlur = 10;
    const label = String(particle.label || "知识粒子");
    const shortLabel = label.length > 28 ? `${label.slice(0, 27)}...` : label;
    context.fillText(shortLabel, x, point.y - 2);
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(80,157,242,.5)";
    context.beginPath();
    context.moveTo(point.x + side * 6, point.y);
    context.lineTo(x - side * 7, point.y);
    context.stroke();
    context.restore();
  }

  particleAt(x, y) {
    let match = null;
    let distance = 22;
    this.particles.forEach((particle) => {
      if (particle.kind === "ambient") return;
      const point = this.toScreen(particle);
      const candidate = Math.hypot(point.x - x, point.y - y);
      if (candidate < distance) { match = particle; distance = candidate; }
    });
    return match;
  }

  selectParticle(particle, { revealLabel = false } = {}) {
    if (!particle) return;
    this.selected = particle;
    this.revealedParticleId = revealLabel ? particle.id : "";
    if (this.motion !== "dynamic") {
      this.draw();
      return;
    }
    this.gatherStarted = this.now;
    this.gatherRelease = 0;
    this.dragTarget = null;
    this.wakeFor(1500);
    this.particles.filter((item) => item !== particle && item.cluster === particle.cluster).slice(0, 8).forEach((item, index) => {
      this.events.push({ from: particle, to: item, started: this.now + index * 34, life: 900 + index * 55 });
    });
  }

  openParticleEditor(particle) {
    if (!particle) return;
    this.selectParticle(particle, { revealLabel: true });
    if (particle.kind === "note") this.callbacks.onNote?.(particle.id);
    if (particle.kind === "skill") this.callbacks.onSkill?.(particle.id);
  }

  bindEvents() {
    const position = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    this.canvas.addEventListener("pointermove", (event) => {
      const point = position(event);
      if (this.pressed && Math.hypot(point.x - this.pointer.x, point.y - this.pointer.y) > 7) this.moved = true;
      this.pointer = { ...point, active: this.motion === "dynamic" };
      if (this.grabbed && this.selected) this.dragTarget = { x: (point.x - this.panX - this.width / 2) / (this.width * this.zoom) + .5, y: (point.y - this.panY - this.height / 2) / (this.height * this.zoom) + .5 };
      if (this.grabbed) this.wakeFor(400);
      else if (this.motion === "dynamic") this.queueDraw();
    });
    this.canvas.addEventListener("pointerleave", () => { this.pointer.active = false; if (this.motion === "dynamic") this.queueDraw(); });
    this.canvas.addEventListener("pointerdown", (event) => {
      const point = position(event);
      this.pointer = { ...point, active: this.motion === "dynamic" };
      this.moved = false;
      if (event.button !== 0) return;
      this.pressed = this.particleAt(point.x, point.y);
      if (this.pressed) this.revealedParticleId = "";
      clearTimeout(this.pressTimer);
      if (this.pressed && this.motion === "dynamic") {
        this.pressTimer = setTimeout(() => {
          this.selected = this.pressed;
          this.gatherStarted = this.now;
          this.dragTarget = { x: this.pressed.x, y: this.pressed.y };
          this.grabbed = true;
          this.wakeFor(1000000);
        }, 420);
      }
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointerup", () => {
      clearTimeout(this.pressTimer);
      if (this.grabbed) {
        this.grabbed = false;
        this.gatherRelease = this.now;
        this.wakeFor(1600);
      } else if (this.pressed && !this.moved) this.selectParticle(this.pressed);
      this.pressed = null;
    });
    this.canvas.addEventListener("pointercancel", () => { clearTimeout(this.pressTimer); this.pressed = null; this.grabbed = false; });
    this.canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const point = position(event);
      const particle = this.particleAt(point.x, point.y);
      if (particle) this.openParticleEditor(particle);
    });
  }

  queueDraw() {
    if (this.animationFrame || this.drawFrame) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = 0;
      this.draw();
    });
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.element.hidden = !this.visible;
    if (!this.visible) this.stopAnimation();
    else this.applyMotion();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.draw();
    this.wakeFor(320);
  }

  setZoom(value, { duration = 220 } = {}) {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, finite(value, 1)));
    if (!this.animationFrame) this.draw();
    this.wakeFor(Math.max(180, finite(duration, 220) + 120));
  }

  destroy() {
    clearTimeout(this.pressTimer);
    if (this.drawFrame) cancelAnimationFrame(this.drawFrame);
    this.stopAnimation();
    this.resizeObserver?.disconnect();
    this.element.replaceChildren();
    this.element.dataset.state = "destroyed";
  }
}

export function create(element, callbacks) {
  if (!element || !window.WebGLRenderingContext) throw new Error("WebGL is unavailable");
  return new LightParticleUniverse(element, callbacks);
}

export { buildGraphData };
