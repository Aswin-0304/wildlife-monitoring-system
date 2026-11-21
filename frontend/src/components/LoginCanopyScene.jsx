import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { computeStage, createIntro } from './forestIntro.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getRangerActor, loadRangerModel, RANGER_HEIGHT } from './rangerActor.js';

// Back layer (WebGL, below the glass card): the painted forest with its banyan on the right, the banyan root she swings
// on, floating motes. Front layer (WebGL, above the card): the ranger (the rigged GLB character), the green trekking
// rope and its carabiner, soft contact shadows, soil / dust / leaves, and — cut from the same painting — the banyan
// trunk at the right edge, so she can pass behind it. The card itself is ordinary page content; the scene only moves it
// (a CSS transform) while the rope tows it to the centre. Both canvases ignore pointer events.

const BG_ASPECT = 1672 / 941;
const BG_SIZE = [1672, 941];
const WORLD_HEIGHT = 6;
// Left edge of the painted banyan trunk in the backdrop (image px, top to bottom).
// Underside of the painted banyan branch across the top right (image px, left to right): the roots grow out of it.
const BRANCH_UNDERSIDE = [[800, 45], [900, 62], [1000, 85], [1060, 120], [1100, 150], [1150, 160], [1200, 166], [1250, 166], [1300, 163], [1350, 160], [1400, 170], [1500, 185], [1672, 195]];
// The top surface of the thick diagonal banyan root that leans down from the horizontal roots towards the forest floor
// (image px, traced from the painting's bark): the ranger lands on it and runs down it before her leap onto the card.
const TREE_ROOT_TOP = [[1322, 180], [1312, 215], [1306, 250], [1297, 280], [1285, 300], [1272, 322], [1262, 345], [1252, 370], [1243, 400], [1229, 422],
  [1212, 442], [1196, 461], [1181, 480], [1167, 500], [1153, 520], [1140, 540], [1127, 560], [1113, 580], [1097, 600], [1082, 620], [1060, 640], [1034, 660],
  [1005, 680], [975, 700], [945, 720]];
const TRUNK_EDGE = [[1672, 150], [1662, 200], [1648, 270], [1625, 340], [1597, 415], [1565, 490], [1530, 565], [1495, 640], [1460, 720], [1425, 800], [1400, 880], [1386, 941]];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function seeded(seed) {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- textures

// Fibrous banyan bark, shared by the 3D roots, the limb, rootlets and moss (so they read as the painted tree's bark):
// braided fibre bundles separated by deep grooves, a lit ridge along each bundle (light from the upper left), fine
// irregular fibres, weathering cracks, lichen and a little moss. Tiles in both directions. The ZOVIVE banyan palette
// (the same one the painted trunk, branches and roots are graded to): aged bark #585038, warm bark #605840, grooves
// #484830, charcoal-olive #505048, muted olive #686850, raised bark #787860, natural highlights #888870, deep shadows
// #28281E, subtle moss #506848.
function barkTextures() {
  const width = 512, height = 1024, rand = seeded(7), TAU = Math.PI * 2;
  const colour = document.createElement('canvas'); colour.width = width; colour.height = height;
  const bump = document.createElement('canvas'); bump.width = width; bump.height = height;
  const c = colour.getContext('2d'), b = bump.getContext('2d');
  const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  c.fillStyle = '#585038'; c.fillRect(0, 0, width, height);
  b.fillStyle = '#6a6a6a'; b.fillRect(0, 0, width, height);
  // weathering: broad soft strips of the palette's bark tones
  const tones = ['#505048', '#605840', '#686850', '#484830', '#585038'];
  for (let i = 0; i < 18; i += 1) {
    const x = rand() * width, w = 24 + rand() * 80, col = tones[Math.floor(rand() * tones.length)];
    for (const sx of [-width, 0, width]) {
      const g = c.createLinearGradient(x + sx - w / 2, 0, x + sx + w / 2, 0);
      g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, 0.5)); g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g; c.fillRect(x + sx - w / 2, 0, w, height);
    }
  }
  // a fibre's centre line down the texture: periodic in y (k whole waves per tile) so it tiles seamlessly
  const stroke = (ctx, style, w, x0, amp, k, ph) => {
    ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const sx of [-width, 0, width]) {
      ctx.beginPath();
      for (let y = -16; y <= height + 16; y += 8) {
        const u = (y / height) * TAU;
        const x = sx + x0 + Math.sin(u * k + ph) * amp + Math.sin(u * (k * 3 + 1) + ph * 1.7) * amp * 0.3;
        if (y === -16) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };
  // braided fibre bundles (later ones cross over earlier ones): deep groove either side, body, lit ridge, shaded side
  for (let i = 0; i < 18; i += 1) {
    const x0 = rand() * width, w = 26 + rand() * 38, amp = 6 + rand() * 18, k = 1 + Math.floor(rand() * 3), ph = rand() * TAU;
    const body = ['#585038', '#605840', '#505048', '#686850', '#585038'][Math.floor(rand() * 5)];
    stroke(c, rgba('#28281E', 0.8), w + 6, x0, amp, k, ph); stroke(b, 'rgba(8,8,8,0.92)', w + 6, x0, amp, k, ph);
    stroke(c, rgba(body, 0.96), w, x0, amp, k, ph); stroke(b, 'rgba(150,150,150,1)', w, x0, amp, k, ph);
    stroke(c, rgba('#484830', 0.5), w * 0.28, x0 + w * 0.3, amp, k, ph); stroke(b, 'rgba(96,96,96,0.7)', w * 0.28, x0 + w * 0.3, amp, k, ph);
    stroke(c, rgba('#787860', 0.42), w * 0.34, x0 - w * 0.2, amp, k, ph); stroke(b, 'rgba(215,215,215,0.9)', w * 0.34, x0 - w * 0.2, amp, k, ph);
    stroke(c, rgba('#888870', 0.22), w * 0.12, x0 - w * 0.28, amp, k, ph); stroke(b, 'rgba(240,240,240,0.85)', w * 0.12, x0 - w * 0.28, amp, k, ph);
  }
  // fine irregular fibres
  for (let i = 0; i < 260; i += 1) {
    const x0 = rand() * width, amp = 2 + rand() * 10, k = 1 + Math.floor(rand() * 4), ph = rand() * TAU, w = 0.6 + rand() * 1.4, light = rand() > 0.5;
    stroke(c, light ? rgba('#888870', 0.1 + rand() * 0.14) : rgba('#28281E', 0.25 + rand() * 0.25), w, x0, amp, k, ph);
    stroke(b, light ? 'rgba(230,230,230,0.35)' : 'rgba(20,20,20,0.45)', w, x0, amp, k, ph);
  }
  // weathering cracks across the fibres
  for (let i = 0; i < 160; i += 1) {
    const x = rand() * width, y = rand() * height, l = 3 + rand() * 11, dy = (rand() - 0.5) * 5, w = 0.8 + rand() * 1.2;
    for (const [ctx, style] of [[c, rgba('#28281E', 0.55)], [b, 'rgba(10,10,10,0.8)']]) {
      ctx.strokeStyle = style; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y + dy); ctx.stroke();
    }
  }
  // weathering: darker charcoal / groove-toned mottling and faint moss staining, as on the painted trunk
  for (let i = 0; i < 40; i += 1) {
    const x = rand() * width, y = rand() * height, r = 20 + rand() * 60, kind = rand();
    const col = kind < 0.45 ? '#28281E' : kind < 0.8 ? '#484830' : '#506848', a = kind < 0.45 ? 0.32 : kind < 0.8 ? 0.4 : 0.3;
    for (const sx of [-width, 0, width]) for (const sy of [-height, 0, height]) {
      const g = c.createRadialGradient(x + sx, y + sy, 0, x + sx, y + sy, r);
      g.addColorStop(0, rgba(col, a)); g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g; c.fillRect(x + sx - r, y + sy - r, r * 2, r * 2);
    }
  }
  // lichen and a little moss
  for (let i = 0; i < 26; i += 1) {
    const x = rand() * width, y = rand() * height, r = 8 + rand() * 30, moss = rand() > 0.4;
    for (const sx of [-width, 0, width]) for (const sy of [-height, 0, height]) {
      const g = c.createRadialGradient(x + sx, y + sy, 0, x + sx, y + sy, r);
      g.addColorStop(0, moss ? rgba('#506848', 0.38) : rgba('#888870', 0.22)); g.addColorStop(1, rgba('#506848', 0));
      c.fillStyle = g; c.fillRect(x + sx - r, y + sy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 1400; i += 1) {
    c.fillStyle = rand() > 0.5 ? rgba('#28281E', 0.32) : rgba('#888870', 0.2);
    c.fillRect(rand() * width, rand() * height, 1 + rand() * 1.5, 1 + rand() * 3);
  }
  const make = (canvas, srgb) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  };
  return { map: make(colour, true), bump: make(bump, false) };
}

// Braided kernmantle climbing rope (sheath of interwoven strands, 2-over-2 twill): u runs round the rope, v along it.
// Palette: main base #8FAE68, dark strands #536B3E, olive strands #718C4F, light strands #B9C98A, highlight fibres
// #D5DDB0, grooves #34482F. Each strand is shaded across its width (rounded), with fine fibres along it; the same
// strand profile gives the normal map, so the braid catches the light as relief, not as a painted pattern.
const ROPE_COLOURS = { base: '#8FAE68', dark: '#536B3E', olive: '#718C4F', light: '#B9C98A', fibre: '#D5DDB0', groove: '#34482F' };
function ropeTextures() {
  const W = 128, H = 256, N = 8, K = 4;                    // 8 strands each way round the rope; K turns per texture repeat
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const C = Object.fromEntries(Object.entries(ROPE_COLOURS).map(([k, v]) => [k, hex(v)]));
  const famA = [C.base, C.dark, C.base, C.olive, C.light, C.base, C.dark, C.olive];
  const famB = [C.olive, C.base, C.light, C.base, C.dark, C.olive, C.base, C.light];
  const colour = document.createElement('canvas'); colour.width = W; colour.height = H;
  const normal = document.createElement('canvas'); normal.width = W; normal.height = H;
  const ci = colour.getContext('2d').createImageData(W, H), ni = normal.getContext('2d').createImageData(W, H);
  const height = new Float32Array(W * H), rand = seeded(23);
  const noise = new Float32Array(W * H).map(() => rand());
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const u = x / W, v = y / H;
    const pa = (u + v * K) * N, pb = (u - v * K) * N + N * 8;
    const ia = Math.floor(pa), ib = Math.floor(pb), fa = pa - ia, fb = pb - ib;
    const aTop = ((ia + ib) >> 1) % 2 === 0;               // 2-over-2 twill: which strand is on top here
    const f = aTop ? fa : fb, idx = (aTop ? ia : ib) % N;
    const prof = Math.sin(Math.PI * f);                    // rounded strand: bright crown, dark edges
    const base = aTop ? famA[idx] : famB[idx];
    // fine fibres along the strand (direction follows the strand's helix)
    const along = aTop ? (u - v * K) : (u + v * K);
    const fib = Math.sin((along * 90 + noise[(y * W + x)] * 0.6) * Math.PI) > 0.86 ? 1 : 0;
    const groove = Math.pow(1 - prof, 3);
    let r = base[0], g = base[1], b = base[2];
    const shade = 0.72 + 0.38 * prof;
    r *= shade; g *= shade; b *= shade;
    const gw = Math.min(1, groove * 1.15); r += (C.groove[0] - r) * gw; g += (C.groove[1] - g) * gw; b += (C.groove[2] - b) * gw;
    const fw = fib * 0.35 * prof; r += (C.fibre[0] - r) * fw; g += (C.fibre[1] - g) * fw; b += (C.fibre[2] - b) * fw;
    const n0 = (noise[(y * W + x)] - 0.5) * 10; r += n0; g += n0; b += n0;
    const o = (y * W + x) * 4;
    ci.data[o] = clamp(r, 0, 255); ci.data[o + 1] = clamp(g, 0, 255); ci.data[o + 2] = clamp(b, 0, 255); ci.data[o + 3] = 255;
    height[y * W + x] = Math.pow(prof, 0.7) * (aTop ? 1 : 0.92) + fib * 0.04;
  }
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const hL = height[y * W + ((x - 1 + W) % W)], hR = height[y * W + ((x + 1) % W)];
    const hU = height[((y - 1 + H) % H) * W + x], hD = height[((y + 1) % H) * W + x];
    let nx = (hL - hR) * 2.2, ny = (hU - hD) * 2.2, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (y * W + x) * 4;
    ni.data[o] = (nx * 0.5 + 0.5) * 255; ni.data[o + 1] = (ny * 0.5 + 0.5) * 255; ni.data[o + 2] = (nz * 0.5 + 0.5) * 255; ni.data[o + 3] = 255;
  }
  colour.getContext('2d').putImageData(ci, 0, 0); normal.getContext('2d').putImageData(ni, 0, 0);
  const make = (canvas, srgb) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = 4;
    return texture;
  };
  return { map: make(colour, true), normal: make(normal, false) };
}

// Mask of the banyan trunk in the backdrop (white = trunk), soft-edged.
function trunkMaskTexture() {
  const w = 418, h = 236, s = w / BG_SIZE[0];
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.filter = 'blur(1.5px)';
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo((BG_SIZE[0] + 20) * s, TRUNK_EDGE[0][1] * s);
  TRUNK_EDGE.forEach(([x, y]) => ctx.lineTo(x * s, y * s));
  ctx.lineTo(TRUNK_EDGE[TRUNK_EDGE.length - 1][0] * s, (BG_SIZE[1] + 20) * s);
  ctx.lineTo((BG_SIZE[0] + 20) * s, (BG_SIZE[1] + 20) * s);
  ctx.closePath(); ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

// Soft round shadow.
function blobTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.45, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------- tubes

function createTube(scene, sections, sides, material, z, renderOrder) {
  const vertices = (sections + 1) * sides;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertices * 2), 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 4).fill(1), 4).setUsage(THREE.DynamicDrawUsage));
  const indices = [];
  for (let row = 0; row < sections; row += 1) for (let side = 0; side < sides; side += 1) {
    const a = row * sides + side, b = row * sides + ((side + 1) % sides), c2 = a + sides, d = b + sides;
    indices.push(a, c2, b, b, c2, d);
  }
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; mesh.renderOrder = renderOrder; mesh.position.z = z;
  mesh.userData = { sections, sides };
  scene.add(mesh);
  return mesh;
}

// sample(t, o) fills o = { x, y, z, r, v, cr, cg, cb, a } for t in [0, 1] (world units; z, colour and alpha default to
// 0 / 1). Runs every frame for every root strand and the rope, so it allocates nothing: the per-row samples live on the
// mesh, and the normals are the tube's own (outward from its centre line) instead of a full computeVertexNormals pass.
function writeTube(mesh, sample) {
  const ud = mesh.userData, { sections, sides } = ud;
  if (!ud.rows) {
    ud.rows = Array.from({ length: sections + 1 }, () => ({ x: 0, y: 0, z: 0, r: 0, v: 0, cr: 1, cg: 1, cb: 1, a: 1 }));
    ud.ca = new Float32Array(sides); ud.sa = new Float32Array(sides);
    for (let side = 0; side < sides; side += 1) { ud.ca[side] = Math.cos((side / sides) * Math.PI * 2); ud.sa[side] = Math.sin((side / sides) * Math.PI * 2); }
  }
  const rows = ud.rows, ca = ud.ca, sa = ud.sa, geometry = mesh.geometry;
  const pos = geometry.attributes.position.array, nor = geometry.attributes.normal.array, uv = geometry.attributes.uv.array, col = geometry.attributes.color.array;
  for (let row = 0; row <= sections; row += 1) {
    const o = rows[row]; o.z = 0; o.cr = 1; o.cg = 1; o.cb = 1; o.a = 1;
    sample(row / sections, o);
  }
  for (let row = 0; row <= sections; row += 1) {
    const p = rows[row], prev = rows[row > 0 ? row - 1 : 0], next = rows[row < sections ? row + 1 : sections];
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    for (let side = 0; side < sides; side += 1) {
      const c = ca[side], sn = sa[side], i = row * sides + side, i3 = i * 3, i4 = i * 4;
      pos[i3] = p.x + nx * c * p.r; pos[i3 + 1] = p.y + ny * c * p.r; pos[i3 + 2] = p.z + sn * p.r;
      nor[i3] = nx * c; nor[i3 + 1] = ny * c; nor[i3 + 2] = sn;
      uv[i * 2] = side / sides; uv[i * 2 + 1] = p.v;
      col[i4] = p.cr; col[i4 + 1] = p.cg; col[i4 + 2] = p.cb; col[i4 + 3] = p.a;
    }
  }
  const a = geometry.attributes;
  a.position.needsUpdate = true; a.normal.needsUpdate = true; a.uv.needsUpdate = true; a.color.needsUpdate = true;
}

// Smooth arc-length parameterised path through points (Catmull-Rom), built into reusable buffers. build(pts, n,
// [px, py]) takes n points (and an optional point put before them); at(s, o) fills o = { x, y, tx, ty }.
function makePath(maxPts) {
  const cap = (maxPts + 1) * 3 + 2;
  const sx = new Float64Array(maxPts + 2), sy = new Float64Array(maxPts + 2);
  const xs = new Float64Array(cap), ys = new Float64Array(cap), cum = new Float64Array(cap);
  let count = 0, total = 1;
  return {
    get total() { return total; },
    build(pts, n, px, py) {
      let N = 0;
      if (px !== undefined) { sx[0] = px; sy[0] = py; N = 1; }
      for (let i = 0; i < n && N < sx.length; i += 1, N += 1) { sx[N] = pts[i].x; sy[N] = pts[i].y; }
      count = 0;
      for (let i = 0; i < N - 1; i += 1) {
        const i0 = i > 0 ? i - 1 : 0, i3 = i + 2 < N ? i + 2 : N - 1;
        for (let k = 0; k < 3; k += 1) {
          const t = k / 3, t2 = t * t, t3 = t2 * t;
          xs[count] = 0.5 * (2 * sx[i] + (-sx[i0] + sx[i + 1]) * t + (2 * sx[i0] - 5 * sx[i] + 4 * sx[i + 1] - sx[i3]) * t2 + (-sx[i0] + 3 * sx[i] - 3 * sx[i + 1] + sx[i3]) * t3);
          ys[count] = 0.5 * (2 * sy[i] + (-sy[i0] + sy[i + 1]) * t + (2 * sy[i0] - 5 * sy[i] + 4 * sy[i + 1] - sy[i3]) * t2 + (-sy[i0] + 3 * sy[i] - 3 * sy[i + 1] + sy[i3]) * t3);
          count += 1;
        }
      }
      xs[count] = sx[N - 1]; ys[count] = sy[N - 1]; count += 1;
      cum[0] = 0;
      for (let i = 1; i < count; i += 1) { const ddx = xs[i] - xs[i - 1], ddy = ys[i] - ys[i - 1]; cum[i] = cum[i - 1] + Math.sqrt(ddx * ddx + ddy * ddy); }
      total = cum[count - 1] || 1;
      return this;
    },
    at(s, o) {
      const target = clamp(s, 0, total);
      let lo = 0, hi = count - 1;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
      const span = cum[hi] - cum[lo] || 1, k = (target - cum[lo]) / span;
      o.x = xs[lo] + (xs[hi] - xs[lo]) * k; o.y = ys[lo] + (ys[hi] - ys[lo]) * k; o.tx = (xs[hi] - xs[lo]) / span; o.ty = (ys[hi] - ys[lo]) / span;
      return o;
    },
  };
}

// ---------------------------------------------------------------- shaders

const backgroundFragment = /* glsl */`
  uniform sampler2D map;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(map, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 lifted = pow(c, vec3(0.86)) * 0.98;
    c = mix(lifted, c, smoothstep(0.08, 0.6, lum));
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.06);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;
// The trunk, cut from the same painting with the same grading, plus the page's light shade (.auth-forest-shade), so it
// matches the backdrop under the glass pixel for pixel. Never drawn over the card.
const trunkFragment = /* glsl */`
  uniform sampler2D map;
  uniform sampler2D mask;
  uniform vec4 uCard;      // the card's box, CSS px (left, top, right, bottom)
  uniform vec2 uScreen;    // canvas size, CSS px
  uniform float uDpr;
  varying vec2 vUv;
  void main() {
    vec2 scr = gl_FragCoord.xy / (uScreen * uDpr);                  // 0..1, y up
    vec2 p = vec2(scr.x * uScreen.x, (1.0 - scr.y) * uScreen.y);     // CSS px, y down
    float inside = step(uCard.x - 6.0, p.x) * step(p.x, uCard.z + 6.0) * step(uCard.y - 6.0, p.y) * step(p.y, uCard.w + 6.0);
    float a = texture2D(mask, vUv).r * (1.0 - inside);
    if (a < 0.004) discard;
    vec3 c = texture2D(map, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 lifted = pow(c, vec3(0.86)) * 0.98;
    c = mix(lifted, c, smoothstep(0.08, 0.6, lum));
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.06);
    // .auth-forest-shade lies over the back canvas, not this one: composite it here the way CSS does (in sRGB).
    vec3 cs = pow(max(c, 0.0), vec3(1.0 / 2.2));
    float av = scr.y < 0.42 ? mix(0.16, 0.0, scr.y / 0.42) : mix(0.0, 0.1, (scr.y - 0.42) / 0.58);
    cs = mix(cs, vec3(2.0, 12.0, 9.0) / 255.0, av);
    vec4 ah = scr.x < 0.6 ? mix(vec4(2.0, 14.0, 10.0, 0.12), vec4(3.0, 19.0, 14.0, 0.08), scr.x / 0.6)
                          : mix(vec4(3.0, 19.0, 14.0, 0.08), vec4(4.0, 18.0, 13.0, 0.14), (scr.x - 0.6) / 0.4);
    cs = mix(cs, ah.rgb / 255.0, ah.a);
    gl_FragColor = vec4(pow(cs, vec3(2.2)), a);
    #include <colorspace_fragment>
  }
`;
const passVertex = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// Soil crumbs, dust puffs, tumbling leaves, wet soil droplets and faint motion streaks.
const particleVertex = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute float aKind;
  attribute float aRot;
  attribute float aTone;
  varying float vAlpha;
  varying float vKind;
  varying float vRot;
  varying float vTone;
  void main() {
    vAlpha = aAlpha; vKind = aKind; vRot = aRot; vTone = aTone;
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const particleFragment = /* glsl */`
  varying float vAlpha;
  varying float vKind;
  varying float vRot;
  varying float vTone;
  void main() {
    vec2 q0 = gl_PointCoord - 0.5;
    q0.y = -q0.y;
    float c = cos(vRot), s = sin(vRot);
    vec2 q = vec2(c * q0.x + s * q0.y, -s * q0.x + c * q0.y);
    float r = length(q0);
    vec4 col;
    if (vKind < 0.5) {            // dust
      float a = (1.0 - smoothstep(0.08, 0.5, r)) * vAlpha * 0.5;
      col = vec4(mix(vec3(0.62, 0.56, 0.44), vec3(0.8, 0.75, 0.62), vTone), a);
    } else if (vKind < 1.5) {     // soil crumb
      if (max(abs(q.x), abs(q.y) * 1.25) > 0.3) discard;
      col = vec4(mix(vec3(0.17, 0.12, 0.07), vec3(0.32, 0.24, 0.15), vTone), vAlpha);
    } else if (vKind < 2.5) {     // leaf
      float t = clamp(q.x + 0.5, 0.0, 1.0);
      float hw = 0.2 * sin(3.14159 * pow(t, 0.8));
      if (abs(q.y) > hw || abs(q.x) > 0.5) discard;
      vec3 g = mix(vec3(0.16, 0.3, 0.1), vec3(0.45, 0.55, 0.18), vTone);
      g = mix(g, vec3(0.5, 0.4, 0.16), step(0.82, vTone) * 0.6);   // the odd dry leaf
      g *= 0.85 + 0.3 * (1.0 - abs(q.y) / max(hw, 0.001));
      g = mix(g, g * 1.3, 1.0 - smoothstep(0.0, 0.03, abs(q.y)));
      col = vec4(g, vAlpha);
    } else if (vKind < 3.5) {     // wet soil droplet
      float a = 1.0 - smoothstep(0.32, 0.42, r);
      if (a < 0.02) discard;
      vec3 d = vec3(0.13, 0.1, 0.07) + 0.18 * (1.0 - smoothstep(0.0, 0.14, length(q0 - vec2(-0.1, 0.1))));
      col = vec4(d, a * vAlpha);
    } else {                      // motion streak
      float a = (1.0 - smoothstep(0.25, 0.5, abs(q.x))) * (1.0 - smoothstep(0.02, 0.07, abs(q.y)));
      col = vec4(0.82, 0.8, 0.68, a * vAlpha * 0.22);
    }
    if (col.a < 0.005) discard;
    gl_FragColor = col;
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------- scene

export default function LoginCanopyScene({ cardRef, reducedMotion, skipIntro = false, onCardReveal, onComplete }) {
  const canvasRef = useRef(null);
  const frontRef = useRef(null);
  const callbacks = useRef({ onCardReveal, onComplete, reducedMotion, skipIntro });
  callbacks.current = { onCardReveal, onComplete, reducedMotion, skipIntro };

  useEffect(() => {
    const canvas = canvasRef.current, front = frontRef.current;
    if (!canvas || !front) return undefined;
    let renderer, frontRenderer, raf = 0, disposed = false;
    const still = callbacks.current.reducedMotion;
    // Low-power devices (data saver, ≤ 2 GB memory or ≤ 2 cores) get the finished scene: she is already seated and the
    // card is in place; the page renders at 1× pixel density.
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const lowPower = Boolean(nav.connection?.saveData || (nav.deviceMemory && nav.deviceMemory <= 2) || (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2));
    // Adaptive resolution: the scene starts at the screen's density (up to 2×; 1× on low-power devices) and steps it
    // down when frames take too long, back up when there is headroom. The animation itself always runs on real time.
    const maxDpr = lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2), minDpr = Math.min(1, maxDpr);
    const quality = { dpr: maxDpr, ema: 1 / 60, frames: 0, calm: 0 };
    const cardEl = cardRef.current;
    // The scene owns the card's position from here on (the page placed it where the intro begins).
    if (cardEl) cardEl.dataset.introCard = 'scene';
    const scene = new THREE.Scene(), frontScene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-5, 5, 3, -3, 0.1, 40);
    camera.position.set(0, 0, 10);
    // Back: the root under the canopy light. Front: the ranger, lit like the forest around her — warm light through
    // the canopy from above and in front, a cool green rim from behind, soft green bounce from below.
    scene.add(new THREE.HemisphereLight('#e2f1d6', '#22372a', 1.5));
    const backKey = new THREE.DirectionalLight('#ffe8c2', 1.7); backKey.position.set(-2.5, 4, 6); scene.add(backKey);
    // Lights on her (front canvas only): sun key, a soft front fill that keeps her face, hands and uniform readable, and
    // two rims from behind that lift her silhouette off the dark forest.
    const frontHemi = new THREE.HemisphereLight('#e9f3de', '#46553a', 1.75); frontScene.add(frontHemi);
    const key = new THREE.DirectionalLight('#ffe4bd', 2.6); key.position.set(2.2, 4, 3.5); frontScene.add(key);
    const fill = new THREE.DirectionalLight('#fff6ea', 1.45); fill.position.set(-0.4, 0.9, 5); frontScene.add(fill);       // soft front fill: face, arms, hands
    const rim = new THREE.DirectionalLight('#e2f8cf', 2.9); rim.position.set(-3, 2, -4); frontScene.add(rim);             // green-gold rim from behind
    const rim2 = new THREE.DirectionalLight('#ffe9c8', 1.7); rim2.position.set(3.5, 1.5, -3); frontScene.add(rim2);

    const world = { halfW: 5, halfH: WORLD_HEIGHT / 2, bgW: 10, bgH: 6, bgX: 0, ppu: 100, left: 0, top: 0, W: 1, H: 1 };
    const disposables = [];
    const textureLoader = new THREE.TextureLoader();
    const ready = { bg: false, actor: null };

    const backgroundMaterial = new THREE.ShaderMaterial({ uniforms: { map: { value: null } }, vertexShader: passVertex, fragmentShader: backgroundFragment, depthWrite: false });
    backgroundMaterial.toneMapped = false;
    const background = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backgroundMaterial);
    background.position.z = -9; background.renderOrder = -5; background.visible = false; scene.add(background);

    // The banyan trunk in front of her (same painting, masked).
    const trunkMask = trunkMaskTexture(); disposables.push(trunkMask);
    const trunkMaterial = new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, mask: { value: trunkMask }, uCard: { value: new THREE.Vector4(-1, -1, -1, -1) }, uScreen: { value: new THREE.Vector2(1, 1) }, uDpr: { value: 1 } },
      vertexShader: passVertex, fragmentShader: trunkFragment,
      transparent: true, depthTest: false, depthWrite: false,
    });
    trunkMaterial.toneMapped = false;
    const trunkMatte = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), trunkMaterial);
    trunkMatte.renderOrder = 60; trunkMatte.frustumCulled = false; trunkMatte.visible = false; frontScene.add(trunkMatte);
    // Drawn only while the timeline has her pass behind the trunk (frame.trunkOver): it can never paint bark over her
    // legs while she lands on, stands on or runs along the tree.
    let trunkReady = false;

    const bark = barkTextures(); disposables.push(bark.map, bark.bump);
    const rootMaterial = new THREE.MeshStandardMaterial({ map: bark.map, bumpMap: bark.bump, bumpScale: 4, color: '#ffffff', roughness: 0.92, metalness: 0, vertexColors: true, transparent: true });
    // (rootlets: the same bark, a touch lighter — raised, weathered; moss: the palette's subtle #506848)
    const rootletMaterial = new THREE.MeshStandardMaterial({ map: bark.map, color: '#d2d2c2', roughness: 1, metalness: 0, vertexColors: true });
    const mossMaterial = new THREE.MeshStandardMaterial({ color: '#506848', roughness: 1, metalness: 0, vertexColors: true, transparent: true });
    // The painted banyan is unlit, but these 3D parts are lit by the back scene's dim canopy light (and tone mapped),
    // which pressed the palette bark almost to black (#0E1307 measured on the new limb). This gain on the shared bark
    // materials, plus the per-part tints below, makes the lit bark land on the painted tree's colours on screen. The
    // master is the painted trunk and thick horizontal roots (measured before the card arrives, all four sizes: painted
    // horizontal roots #4E5037-#515539, trunk #454D31-#4C5534; 3D roots #484B32-#4A4C33, 3D limb #4B4F38-#50553E;
    // at equal brightness, L65-85, all within +-3 of #4A4D35). The moss uses the same bark map, tinted towards #506848.
    const BARK_GAIN = [7.18, 6.28, 8.8];
    rootMaterial.color.setRGB(...BARK_GAIN);
    rootletMaterial.color.multiply(new THREE.Color().setRGB(...BARK_GAIN));
    mossMaterial.map = bark.map;
    mossMaterial.color.setRGB(6.0, 7.5, 9.1);
    // the hanging roots face the key light more squarely than the limb: a little darker so they sit with the painted roots
    const ROOT_TINT = 0.86;
    const ropeTex = ropeTextures(); disposables.push(ropeTex.map, ropeTex.normal);
    // Matte braided nylon: rough, no sheen of plastic; the braid's relief comes from the normal map.
    const ropeMaterial = new THREE.MeshStandardMaterial({ map: ropeTex.map, normalMap: ropeTex.normal, normalScale: new THREE.Vector2(0.9, 0.9), color: '#ffffff',
      roughness: 0.86, metalness: 0, envMapIntensity: 0.35, vertexColors: true, transparent: true });

    // The banyan roots (three twisted strands each, hairy rootlets), growing out of the painted branch, behind the glass:
    // the one she jumps for, the one by the card's corner, and thinner ones around them.
    const ROOTLETS = [{ at: 0.12, len: 0.07, side: 1 }, { at: 0.3, len: 0.1, side: -1 }, { at: 0.55, len: 0.12, side: 1 }, { at: 0.8, len: 0.08, side: -1 }, { at: 1.15, len: 0.14, side: 1 }, { at: 1.6, len: 0.1, side: -1 },
      { at: 2.1, len: 0.26, side: 1, moss: true }, { at: 2.7, len: 0.16, side: -1 }, { at: 3.3, len: 0.22, side: -1, moss: true }, { at: 3.9, len: 0.12, side: 1 }, { at: 4.6, len: 0.18, side: -1 }];
    const rootMeshes = Array.from({ length: 6 }, (_, k) => ({
      // braided strands: five on the two main roots, four on the thinner ones
      strands: (k < 2 ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]).map((i) => createTube(scene, k < 2 ? 150 : 60, i ? 7 : (k < 2 ? 12 : 8), rootMaterial, -5.4 - k * 0.03 - i * 0.008, 2)),
      rootlets: (k < 2 ? ROOTLETS : ROOTLETS.slice(0, 5)).map((spec) => ({ ...spec, mesh: createTube(scene, 10, 5, spec.moss ? mossMaterial : rootletMaterial, -5.36 - k * 0.03, 2) })),
    }));
    // The climbing rope (one tube; after it breaks, one tube per half), its shadows, and the anchor on the card.
    const ropeShadowMaterial = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.3, depthWrite: false });
    const ropeMesh = createTube(frontScene, 72, 10, ropeMaterial, -0.08, 18);
    ropeMesh.visible = false;
    const ropeShadow = createTube(frontScene, 72, 5, ropeShadowMaterial, -0.1, 17);
    ropeShadow.visible = false;
    const ropeMesh2 = createTube(frontScene, 40, 10, ropeMaterial, -0.08, 18); ropeMesh2.visible = false;
    const ropeShadow2 = createTube(frontScene, 40, 5, ropeShadowMaterial, -0.1, 17); ropeShadow2.visible = false;
    const steel = new THREE.MeshStandardMaterial({ color: '#c9ccc4', roughness: 0.32, metalness: 0.75, transparent: true });
    // The anchor on the card's right border: a bolt hanger plate fixed to the border, and a steel ring through it that
    // the rope is tied to (the ring hangs out from the border, so the rope leaves it clear of the card).
    const carabiner = new THREE.Group(); carabiner.visible = false; frontScene.add(carabiner);
    const anchorPlate = new THREE.Mesh(new THREE.BoxGeometry(1, 1.9, 0.35), steel); anchorPlate.renderOrder = 19; carabiner.add(anchorPlate);
    const anchorBolt = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 12), steel); anchorBolt.rotation.x = Math.PI / 2; anchorBolt.position.set(0, 0.45, 0.3); anchorBolt.renderOrder = 20; carabiner.add(anchorBolt);
    const anchorRing = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.2, 10, 24), steel); anchorRing.position.set(0.9, -0.35, 0.1); anchorRing.rotation.set(0, 0.5, 0); anchorRing.renderOrder = 20; carabiner.add(anchorRing);
    // Soft contact shadows where she stands or sits on the card.
    const blob = blobTexture(); disposables.push(blob);
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: blob, color: '#000000', transparent: true, opacity: 0.4, depthWrite: false });
    const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial);
    contactShadow.renderOrder = 16; contactShadow.visible = false; frontScene.add(contactShadow);
    const legShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial.clone());
    legShadow.renderOrder = 15; legShadow.visible = false; frontScene.add(legShadow);

    const moteCount = 54, moteGeometry = new THREE.BufferGeometry(), motePositions = new Float32Array(moteCount * 3);
    const moteSeed = seeded(3);
    for (let i = 0; i < moteCount; i += 1) { motePositions[i * 3] = (moteSeed() - 0.5) * 12; motePositions[i * 3 + 1] = (moteSeed() - 0.48) * 5.5; motePositions[i * 3 + 2] = -4.1 + moteSeed() * 1.2; }
    const moteBase = motePositions.slice();
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
    const motes = new THREE.Points(moteGeometry, new THREE.PointsMaterial({ color: '#d4f3a8', size: 0.026, transparent: true, opacity: 0.4, depthWrite: false }));
    motes.renderOrder = 4; scene.add(motes);

    // Particles.
    const MAX_P = 220;
    const pGeometry = new THREE.BufferGeometry();
    const pAttr = (name, size) => pGeometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(MAX_P * size), size).setUsage(THREE.DynamicDrawUsage));
    pAttr('position', 3); pAttr('aSize', 1); pAttr('aAlpha', 1); pAttr('aKind', 1); pAttr('aRot', 1); pAttr('aTone', 1);
    const pMaterial = new THREE.ShaderMaterial({ vertexShader: particleVertex, fragmentShader: particleFragment, transparent: true, depthTest: false, depthWrite: false });
    pMaterial.toneMapped = false;
    const particlePoints = new THREE.Points(pGeometry, pMaterial);
    particlePoints.frustumCulled = false; particlePoints.renderOrder = 50; frontScene.add(particlePoints);
    const KIND = { dust: 0, grit: 1, leaf: 2, splash: 3, streak: 4 };

    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(quality.dpr);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      frontRenderer = new THREE.WebGLRenderer({ canvas: front, alpha: true, antialias: true, powerPreference: 'high-performance' });
      frontRenderer.setPixelRatio(renderer.getPixelRatio());
      frontRenderer.outputColorSpace = THREE.SRGBColorSpace;
      frontRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      frontRenderer.toneMappingExposure = 1.05;
      frontRenderer.setClearColor(0x000000, 0);
      // A soft, neutral environment for her materials (skin, fabric, leather, metal) to reflect.
      const pmrem = new THREE.PMREMGenerator(frontRenderer);
      const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      frontScene.environment = envTexture; disposables.push(envTexture);
      pmrem.dispose();
    } catch {
      // No WebGL: the card glides straight to the centre and the page carries on without the scene.
      if (cardEl) { cardEl.style.transition = 'transform .45s cubic-bezier(.2,.7,.2,1)'; cardEl.style.transform = ''; delete cardEl.dataset.introCard; }
      callbacks.current.onCardReveal?.(); callbacks.current.onComplete?.();
      return () => {};
    }

    const loadTexture = (url, onLoad, srgb = true) => textureLoader.load(url, (texture) => {
      if (disposed) { texture.dispose(); return; }
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      disposables.push(texture); onLoad(texture);
    }, undefined, () => onLoad(null));
    // The backdrop with the banyan (trunk, branches, hanging roots) graded to the ZOVIVE bark palette (the original
    // painting is kept as forest-banyan-backdrop.png).
    loadTexture('/images/forest-banyan-backdrop-zovive.png', (texture) => {
      if (texture) { backgroundMaterial.uniforms.map.value = texture; trunkMaterial.uniforms.map.value = texture; background.visible = true; trunkReady = true; }
      ready.bg = true;
    });

    // The ranger: the rigged GLB character (Phase 7: Phase 6's body and uniform with eyes, eyelids, five-finger hands,
    // backpack and binoculars; Phase 6 if it cannot load). Downloaded once per page session; the same instance is reused
    // when the login page mounts again.
    let actor = null;
    let ropeCoil = [], ropeCoilShown = true;
    loadRangerModel().then((gltf) => {
      if (disposed) return;
      actor = getRangerActor(gltf, { anisotropy: Math.min(frontRenderer.capabilities.getMaxAnisotropy(), 4) });
      // The front lights were set for the previous ranger's very dark textures; with Phase 6's true-colour albedo they
      // washed the uniform out (shirt #556B2F rendered #aabe6c, black harness as olive grey). Same lights, lower
      // exposure on the front canvas only (ranger, rope, carabiner; the forest behind is untouched): lit cloth now reads
      // about 1.5x its palette colour (shirt #809846, hat #507247, boots #77513d), as a sunlit figure should.
      if (!actor.legacy) frontRenderer.toneMappingExposure = 0.68;
      actor.meshes.forEach((mesh) => {
        (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => {
          if (!actor.legacy) {
            // Phase 6: the baked textures and PBR values are the final look; only how much of the room environment they
            // reflect is set here (skin a little less than cloth, leather and metal, as before).
            // Eyes and lens glass reflect the room a little more: a living catchlight in her eyes.
            material.envMapIntensity = /Skin|Lips|Lid/.test(material.name) ? 0.45 : /Eye$|Glass/.test(material.name) ? 1.1 : 0.6;
            // Lips and brows a touch deeper than in the Blender file, so her smile and brows read at page size.
            if (material.name === 'ZOVIVE_Lips') { material.color.set('#b24f57'); material.roughness = 0.38; }
            if (material.name === 'ZOVIVE_Brows') material.color.set('#1d130c');
            if (material.name === 'ZOVIVE_MouthLine') material.color.set('#3a1614');
            return;
          }
          // Skin: the export multiplies the skin texture by a deep orange; a lighter, more natural tan reads better in
          // the forest light (same texture, same detail).
          if (material.name === 'Skin') material.color.setRGB(0.72, 0.47, 0.33);
          // Uniform shirt: the export lost its olive tint (#536B3D in her settings) and came out near-black; restore
          // it (keeping the fabric's normal map) so the uniform reads against the forest.
          if (material.name === 'Uniform shirt') { material.map = null; material.color.set('#5b7044'); material.needsUpdate = true; }
          if (material.name === 'Skin') material.roughness = 0.74;
          if (material.normalMap && /pants|shirt|Backpack|Boot|belt|straps/i.test(material.name)) material.normalScale.set(1.4, 1.4);
          material.envMapIntensity = /Skin|Eyes/.test(material.name) ? 0.45 : 0.6;
        });
      });
      // Both pairs of sunglasses off, so her eyes (and where she looks) can be seen.
      actor.meshes.forEach((mesh) => { if (/Aviators|Sunglasses/.test(mesh.material?.name || '')) mesh.visible = false; });
      // The green rope coil on her hip (the rope pays out from it): hidden together with the rope once it is gone.
      ropeCoil = actor.meshes.filter((m) => /(^|_)Rope$/.test(m.material?.name || ''));
      ropeCoil.forEach((m) => { m.visible = true; });   // the same character is reused on a later visit: start shown
      actor.setVisible(false);
      frontScene.add(actor.root);
      ready.actor = true;
    }).catch(() => { ready.actor = false; });

    // ------------------------------------------------------------ px ↔ world
    const wx = (px) => px / world.ppu - world.halfW;
    const wy = (py) => world.halfH - py / world.ppu;
    const wr = (r) => r / world.ppu;
    const sx = (x) => (x + world.halfW) * world.ppu;
    const sy = (y) => (world.halfH - y) * world.ppu;

    // ------------------------------------------------------------ layout from the DOM
    let intro = null, dpr = 1;
    // The card's resting box (layout position, ignoring the tow transform) and how far it is shifted right now.
    const measureCard = () => {
      const card = cardRef.current, parent = card?.offsetParent;
      if (!card || !parent || !card.offsetWidth || !card.offsetHeight) return null;
      const box = parent.getBoundingClientRect();
      const left = box.left + card.offsetLeft - world.left, top = box.top + card.offsetTop - world.top;
      const now = card.getBoundingClientRect();
      return { left, top, right: left + card.offsetWidth, bottom: top + card.offsetHeight, shiftX: now.left - world.left - left, shiftY: now.top - world.top - top };
    };
    // Text and controls near the top of the card: her seated legs hang over empty glass instead.
    const measureBlocked = (cardBox) => {
      const card = cardRef.current;
      if (!card || !cardBox) return [];
      const out = [];
      const reach = cardBox.top + 0.45 * (cardBox.bottom - cardBox.top);
      const push = (r) => {
        const rr = { left: r.left - world.left - cardBox.shiftX, right: r.right - world.left - cardBox.shiftX, top: r.top - world.top - cardBox.shiftY, bottom: r.bottom - world.top - cardBox.shiftY };
        if (r.width && r.height && rr.top < reach) out.push(rr);
      };
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        range.selectNodeContents(node);
        [...range.getClientRects()].forEach(push);
      }
      card.querySelectorAll('input, button, select, textarea, .auth-encryption, .auth-eyebrow').forEach((el) => { if (el.offsetParent) push(el.getBoundingClientRect()); });
      return out;
    };
    // The trunk's left edge on screen (px), from the backdrop's placement.
    const onScreen = (pts) => {
      const u2x = (u) => sx(world.bgX - world.bgW / 2 + u * world.bgW);
      const v2y = (v) => sy(world.bgH / 2 - v * world.bgH);
      return pts.map(([x, y]) => [u2x(x / BG_SIZE[0]), v2y(y / BG_SIZE[1])]);
    };
    const trunkOnScreen = () => onScreen(TRUNK_EDGE);

    // Braided aerial root: a thick core that wanders a little off-centre, and strands of different girth that wind round
    // it at different (and varying) pitches, splitting away and fusing again, some ending part-way down.
    const strandShape = [{ r: 0.8, o: 0.14, pitch: 2.6, start: 0 }, { r: 0.42, o: 0.62, pitch: 1.5, start: 0 }, { r: 0.28, o: 0.72, pitch: 0.95, start: 0.35 },
      { r: 0.33, o: 0.66, pitch: 1.2, start: 0.12 }, { r: 0.21, o: 0.8, pitch: 0.8, start: 0.55 }];
    // The banyan root along its simulated chain: braided strands, irregular woody girth, a frayed tip.
    const tmpP = { x: 0, y: 0, tx: 0, ty: 0 }, cP = { x: 0, y: 0, tx: 0, ty: 0 };
    function drawRoot(rootMesh, pts0, h, time, rs = 1) {
      // Continue the root a little up into the branch, fading in, so it grows out of the bark rather than starting at it.
      const dx0 = pts0[1].x - pts0[0].x, dy0 = pts0[1].y - pts0[0].y, d0 = Math.hypot(dx0, dy0) || 1;
      const into = 0.07 * h;
      if (!rootMesh.path) rootMesh.path = makePath(pts0.length + 2);
      const path = rootMesh.path.build(pts0, pts0.length, pts0[0].x - (dx0 / d0) * into, pts0[0].y - (dy0 / d0) * into);
      const length = path.total;
      const scale = h / 1.8;
      const wav = rs < 0.8 ? 1.8 : 1;
      // The centre line at t, into o (with the path's direction there).
      const centre = (t, o) => {
        path.at(t * length, tmpP);
        const s = t * length, fromEnd = length - s;
        const ends = smoothstep(0, 0.2 * scale, s) * smoothstep(0, 0.12 * scale, fromEnd);
        // A root is never a straight rod: it wanders gently, more so the thinner it is.
        const kink = scale * wav * (0.03 * Math.sin(fromEnd / scale * 2.3 + 0.7 + rs * 5) + 0.014 * Math.sin(fromEnd / scale * 6.1 + 2.3) + 0.006 * Math.sin(fromEnd / scale * 13.7 + rs * 9)) * ends;
        o.x = tmpP.x - tmpP.ty * kink; o.y = tmpP.y + tmpP.tx * kink; o.tx = tmpP.tx; o.ty = tmpP.ty;
        return o;
      };
      const tipR = 0.018 * h * rs, baseR = 0.058 * h * rs;
      rootMesh.strands.forEach((mesh, index) => {
        mesh.visible = true;
        const shape = strandShape[index];
        writeTube(mesh, (t, o) => {
          const c = centre(t, cP);
          const s = t * length, fromEnd = length - s, f = fromEnd / scale;
          const node = ((f + 0.31 * index) % 1.37) - 0.68;
          const lumps = 1 + 0.15 * Math.sin(f * 2.3 + index * 2.1) + 0.08 * Math.sin(f * 5.3 + 1.7 + index) + 0.03 * Math.sin(f * 15.1 + index * 4.0) + 0.16 * Math.exp(-(node * node) / 0.0035);
          // the whole root swells and narrows slowly along its length (subtle, different on every root)
          const swell = 1 + 0.12 * Math.sin(f * 0.42 + rs * 7.3) + 0.06 * Math.sin(f * 1.13 + rs * 3.1);
          const tip = 0.4 + 0.6 * smoothstep(0, 0.25 * scale, fromEnd);
          const collar = 1 + 0.75 * Math.exp(-Math.max(0, s - into) / (0.09 * scale));   // the root flares where it leaves the branch
          const bundle = (tipR + (baseR - tipR) * Math.max(0, 1 - s / (6 * h))) * lumps * swell * tip * collar;
          const splay = 1 + 0.8 * (1 - smoothstep(0, 0.12 * scale, fromEnd));
          // the twist tightens and loosens along the root; strands now and then split away from the bundle and fuse again
          const wander = (f / shape.pitch) * Math.PI * 2 * (1 + 0.22 * Math.sin(f * 0.31 + index * 1.3 + rs * 2)) + index * 2.4 + 1.6 * Math.sin(f * 0.8 + index * 1.7) + 0.6 * Math.sin(f * 2.9 + index);
          const separate = 0.78 + 0.35 * Math.max(0, Math.sin(f * 0.7 + index * 1.9)) + 0.5 * Math.max(0, Math.sin(f * 0.37 + index * 2.7 + rs * 4)) ** 3;
          const offset = bundle * shape.o * separate * splay;
          let tx = c.tx, ty = c.ty; const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
          // Moss in patches along the root; the lower end weathered paler, like the painted roots around it.
          const moss = 0.35 * Math.max(0, Math.sin(f * 1.9 + index * 3.1)) ** 4 + 0.2 * smoothstep(0.6, 0.95, Math.sin(f * 0.53 + 1.1 + index));
          const grow = shape.start ? smoothstep(shape.start * length, shape.start * length + 0.2 * scale, fromEnd) : 1;
          const pale = 0.1 * (1 - smoothstep(0, 0.6 * scale, fromEnd));
          const cw = Math.cos(wander) * offset * grow;
          o.x = wx(c.x - ty * cw); o.y = wy(c.y + tx * cw); o.z = wr(Math.sin(wander) * offset * grow);
          o.r = wr(bundle * shape.r * (index ? grow : 1)); o.v = fromEnd / (1.0 * scale) + index * 0.37;   // texture in proportion: ~2 circumferences per repeat
          // neutral olive (no warm cast): moss patches lean towards #506848, the weathered lower end slightly paler
          const ti = Math.min(index, 2);   // the same per-strand shading as before for the added strands (no colour change)
          o.cr = ROOT_TINT * (1.0 - moss * 0.3 + pale - ti * 0.04); o.cg = ROOT_TINT * (1.0 - moss * 0.08 + pale - ti * 0.04); o.cb = ROOT_TINT * (0.97 - moss * 0.28 + pale - ti * 0.03);
          o.a = (index ? smoothstep(0, 0.4, grow) : 1) * smoothstep(0, into * 0.9, s);
        });
      });
      rootMesh.rootlets.forEach(({ mesh, at, len, side, moss }) => {
        const along = at * scale + into;
        if (along > length - 0.25 * scale) { mesh.visible = false; return; }
        mesh.visible = true;
        centre(1 - along / length, cP);
        const bx = cP.x, by = cP.y;
        const hang = len * scale;
        const drift = Math.sin(time * 0.0016 + at * 9) * 0.012 * scale;
        writeTube(mesh, (t, o) => {
          o.x = wx(bx + side * 0.01 * scale + side * hang * (moss ? 0.08 : 0.3) * t + drift * t * t); o.y = wy(by + hang * t * (0.75 + 0.25 * t)); o.z = 0.025;
          o.r = wr(((moss ? 0.0032 : 0.0042) * (1 - t * 0.8) + 0.001) * scale * 1.6 * Math.max(0.7, rs)); o.v = t * 0.4 + at;
        });
      });
    }
    const hideRoot = (rootMesh) => { rootMesh.strands.forEach((m) => { m.visible = false; }); rootMesh.rootlets.forEach(({ mesh }) => { mesh.visible = false; }); };

    // The trekking rope along its simulated chain; its last point is moved onto her real harness.
    const ropeBuf = Array.from({ length: 64 }, () => ({ x: 0, y: 0 })), ropePath = makePath(64);
    const ropeBuf2 = Array.from({ length: 64 }, () => ({ x: 0, y: 0 })), ropePath2 = makePath(64);
    function ropeTube(mesh, shadow, path, buf, n, S, k) {
      const built = path.build(buf, n);
      const L = built.total, R = Math.max(2, 0.013 * S), offX = 0.5 * R, offY = 1.0 * R;
      writeTube(mesh, (t, o) => { built.at(t * L, tmpP); o.x = wx(tmpP.x); o.y = wy(tmpP.y); o.r = wr(R); o.v = (t * L) / (R * 6.5); });
      writeTube(shadow, (t, o) => { built.at(t * L, tmpP); o.x = wx(tmpP.x + offX); o.y = wy(tmpP.y + offY); o.r = wr(R * 1.15); o.v = 0; });
      mesh.position.z = -0.12 * k; mesh.visible = true; shadow.visible = true;
    }
    function drawRope(rope, S, harnessPx, k) {
      if (!rope) { ropeMesh.visible = false; ropeShadow.visible = false; ropeMesh2.visible = false; ropeShadow2.visible = false; carabiner.visible = false; return; }
      // After the break both halves (and their shadows and the anchor) fade out together over 450 ms.
      const fade = rope.fade ?? 1;
      ropeMaterial.opacity = fade; ropeShadowMaterial.opacity = 0.3 * fade; steel.opacity = fade;
      const halves = rope.segments || [rope.pts];
      const snap = (buf, n) => {
        // The end at her harness follows her exactly (the simulation runs at its own step).
        if (!harnessPx || !rope.clipped) return;
        const ex = harnessPx[0] - buf[n - 1].x, ey = harnessPx[1] - buf[n - 1].y;
        for (let i = 0; i < n; i += 1) { const w = smoothstep(0.5, 1, i / (n - 1)); buf[i].x += ex * w; buf[i].y += ey * w; }
      };
      const fill = (buf, pts) => { const n = Math.min(pts.length, buf.length); for (let i = 0; i < n; i += 1) { buf[i].x = pts[i].x; buf[i].y = pts[i].y; } return n; };
      if (halves.length === 1) {
        const n = fill(ropeBuf, halves[0]); snap(ropeBuf, n);
        ropeTube(ropeMesh, ropeShadow, ropePath, ropeBuf, n, S, k);
        ropeMesh2.visible = false; ropeShadow2.visible = false;
      } else {
        const n1 = fill(ropeBuf, halves[0]);
        ropeTube(ropeMesh, ropeShadow, ropePath, ropeBuf, n1, S, k);
        const n2 = fill(ropeBuf2, halves[1]); snap(ropeBuf2, n2);
        ropeTube(ropeMesh2, ropeShadow2, ropePath2, ropeBuf2, n2, S, k);
      }
      if (rope.ring) {
        // The ring's centre is the rope's anchor point; the plate sits on the border just to its left.
        carabiner.visible = true;
        const s = wr(Math.max(3.2, 0.02 * S));
        carabiner.scale.set(s, s, s);
        carabiner.position.set(wx(rope.ring[0]) - 0.9 * s, wy(rope.ring[1]) + 0.35 * s, 0.2);
        carabiner.rotation.set(0, 0, 0);
      } else carabiner.visible = false;
    }

    // ------------------------------------------------------------ the card's position
    let appliedCard = { dx: null, dy: null };
    function placeCard(off) {
      const card = cardRef.current;
      if (!card) return;
      const dx = Math.round(off.dx * 10) / 10, dy = Math.round(off.dy * 10) / 10;
      if (dx === appliedCard.dx && dy === appliedCard.dy) return;
      appliedCard = { dx, dy };
      card.style.transition = 'none';
      card.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : '';
      card.classList.toggle('auth-card-towed', !!(dx || dy));
    }

    // ------------------------------------------------------------ the ranger
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vP = new THREE.Vector3(), vT = new THREE.Vector3();
    const vS1 = new THREE.Vector3(), vS2 = new THREE.Vector3();
    const LIMB_END = { leftArm: 'LeftHand', rightArm: 'RightHand', leftLeg: 'LeftFoot', rightLeg: 'RightFoot' };
    const contactProbe = import.meta.env.DEV && /[?&](introAt|rangerClip)=/.test(window.location.search) ? [] : null;
    const harnessLocal = new THREE.Vector3(0, -0.02, 0.14);
    const actorState = { harness: null, k: 1, visible: false, lastT: null, smile: 0, brow: 0, react: null };
    // Blinks every 2.6–5 s (a fixed, irregular rhythm on the intro's own clock, so a frame looks the same when replayed):
    // the lids close in 70 ms, stay shut 40 ms and open over 150 ms.
    const BLINK_GAPS = [2.6, 3.7, 3.1, 4.4, 2.8, 3.5, 5.0, 3.0];
    const BLINK_CYCLE = BLINK_GAPS.reduce((a, b) => a + b, 0);
    const blinkAt = (t) => {
      if (!(t > 0.9)) return 0;
      let s0 = 0.9 + Math.floor((t - 0.9) / BLINK_CYCLE) * BLINK_CYCLE;
      for (let i = 0; i < BLINK_GAPS.length && s0 + BLINK_GAPS[i] <= t; i += 1) s0 += BLINK_GAPS[i];
      const u = t - s0;
      if (u < 0.07) { const x = u / 0.07; return x * x; }
      if (u < 0.11) return 1;
      if (u < 0.26) { const x = (u - 0.11) / 0.15; return 1 - x * (2 - x); }
      return 0;
    };
    // Her expression through the intro (smile, raised brows): alert in the leap and the flip, focused on the root,
    // pleased once she lands and sits. Eyes: up the root while she climbs.
    const EXPRESSION = {
      JumpIn: [0.25, 0.35], JumpAirborne: [0.3, 0.45], RootCatch: [0.2, 0.3], Hanging: [0.25, 0.2], SwingRight: [0.35, 0.2],
      TravelRight: [0.3, 0.2], RootRelease: [0.25, 0.3], TrunkPlant: [0.3, 0.15], TrunkPush: [0.25, 0.4], LeapToCard: [0.4, 0.35],
      LandingPrep: [0.4, 0.25], LandingAbsorb: [0.55, 0.1], SitDown: [0.7, 0.05], Sit: [0.8, 0.05], InteractiveSitIdle: [0.8, 0.05],
    };
    function driveFace(desc, frame, dt) {
      if (!actor?.hasFace) return;
      const now = performance.now();
      let [smileT, browT] = EXPRESSION[desc.phase || frame?.phase] || [0.6, 0.05];
      // Brows alive: a slow, slight lift and settle (and a little more when she glances up), never fixed.
      const tt = intro?.time ?? 0;
      browT += 0.06 * Math.max(0, Math.sin(tt * 0.9)) + 0.04 * Math.max(0, -(desc.tweaks?.eyePitch || 0));
      const r = actorState.react;
      if (r && now - r.t < 1600) {
        if (r.kind === 'submit') { smileT = 0.85; browT = 0.35; } else if (r.kind === 'error') { smileT = 0; browT = 0.45; }
      }
      const k = dt > 0 ? 1 - Math.exp(-dt * 5) : 1;
      actorState.smile += (smileT - actorState.smile) * k; actorState.brow += (browT - actorState.brow) * k;
      actor.expression({ blink: still ? 0 : blinkAt(intro?.time ?? 0), smile: actorState.smile, brow: actorState.brow });
    }
    function driveActor(desc, stage, frame, dt = 0) {
      if (!actor) return;
      if (!desc) { actor.setVisible(false); actorState.visible = false; actorState.harness = null; return; }
      actor.setVisible(true); actorState.visible = true;
      actor.pose(desc.layers);
      const tw = desc.tweaks || {};
      if (tw.legSwing !== undefined) {
        const s = tw.legSwing, fwd = Math.max(0, s), back = Math.max(0, -s);
        const hip = 0.18 + 0.62 * fwd - 0.28 * back, knee = 0.22 + 0.55 * back + 0.18 * fwd;
        actor.turn('LeftUpLeg', 'x', hip * 1.06); actor.turn('RightUpLeg', 'x', hip * 0.94);
        actor.turn('LeftLeg', 'x', -knee * 0.94); actor.turn('RightLeg', 'x', -knee * 1.08);
      }
      if (tw.sitLegs) {
        // Seated on the edge: knees a little closer together than the chair clip (relaxed, not pressed), lower legs
        // hanging a little forward.
        const a = tw.sitLegs;
        actor.turn('LeftUpLeg', 'z', -0.17 * a); actor.turn('RightUpLeg', 'z', 0.17 * a);
        actor.turn('LeftLeg', 'x', 0.1 * a); actor.turn('RightLeg', 'x', 0.1 * a);
        // Arms in a little so her hands rest on her thighs.
        actor.turn('LeftArm', 'z', -0.21 * a); actor.turn('RightArm', 'z', 0.21 * a);
        actor.turn('LeftArm', 'x', 0.08 * a); actor.turn('RightArm', 'x', 0.08 * a);
      }
      if (tw.tuck) {
        // In the air: knees drawn up.
        actor.turn('LeftUpLeg', 'x', 0.85 * tw.tuck); actor.turn('RightUpLeg', 'x', 0.75 * tw.tuck);
        actor.turn('LeftLeg', 'x', -1.25 * tw.tuck); actor.turn('RightLeg', 'x', -1.1 * tw.tuck);
      }
      if (tw.climbLegs) {
        // Climbing the root: knees up, boots brought in to clamp it (inverse kinematics then puts them on it).
        actor.turn('LeftUpLeg', 'x', 0.9 * tw.climbLegs); actor.turn('RightUpLeg', 'x', 0.8 * tw.climbLegs);
        actor.turn('LeftLeg', 'x', -1.3 * tw.climbLegs); actor.turn('RightLeg', 'x', -1.2 * tw.climbLegs);
      }
      if (tw.shrug) { actor.turn('LeftShoulder', 'z', -tw.shrug); actor.turn('RightShoulder', 'z', tw.shrug); }
      if (tw.shrugL) actor.turn('LeftShoulder', 'z', -tw.shrugL);
      if (tw.shrugR) actor.turn('RightShoulder', 'z', tw.shrugR);
      if (tw.foot) { actor.turn('LeftFoot', 'x', tw.foot); actor.turn('RightFoot', 'x', 0.85 * tw.foot); }
      if (actor.hasEyes) {
        // Phase 7: her eyes lead where she looks (the head follows); climbing, they look up the root at the next hold.
        const climbing = desc.phase === 'ClimbRoot' ? -0.22 : 0;
        actor.look(0.6 * (tw.eyeYaw || 0), 0.6 * (tw.eyePitch || 0) + climbing);
      } else if (tw.eyeYaw || tw.eyePitch) {
        ['LeftEye', 'RightEye'].forEach((n) => { actor.turn(n, 'z', -0.5 * (tw.eyeYaw || 0)); actor.turn(n, 'x', -0.6 * (tw.eyePitch || 0)); });
      }
      if (tw.legL) actor.turn('LeftLeg', 'x', tw.legL);
      if (tw.legR) actor.turn('RightLeg', 'x', tw.legR);
      if (tw.breathe) { actor.turn('Spine1', 'x', 0.012 * tw.breathe); actor.turn('Spine2', 'x', 0.008 * tw.breathe); }
      if (desc.seat && !still) {
        // Seated: small, natural head movements (a slight tilt and nod), on the intro's clock.
        const tt = intro?.time ?? 0;
        actor.turn('Head', 'z', 0.035 * Math.sin(tt * 0.75) + 0.015 * Math.sin(tt * 1.9 + 1));
        actor.turn('Head', 'x', 0.02 * Math.sin(tt * 1.3 + 0.5));
      }
      if (tw.sway) actor.turn('Spine', 'z', tw.sway);
      if (tw.headYaw || tw.headPitch) {
        actor.turn('Neck', 'y', 0.35 * (tw.headYaw || 0)); actor.turn('Head', 'y', 0.65 * (tw.headYaw || 0));
        actor.turn('Neck', 'x', 0.35 * (tw.headPitch || 0)); actor.turn('Head', 'x', 0.65 * (tw.headPitch || 0));
      }
      if (tw.hangLegs) {
        // Hanging: legs relaxed under her weight — knees a little bent (one more than the other), toes pointing down.
        const a = tw.hangLegs;
        actor.turn('LeftUpLeg', 'x', 0.1 * a); actor.turn('RightUpLeg', 'x', 0.22 * a);
        actor.turn('LeftLeg', 'x', -0.22 * a); actor.turn('RightLeg', 'x', -0.4 * a);
        actor.turn('LeftFoot', 'x', 0.45 * a); actor.turn('RightFoot', 'x', 0.38 * a);
      }
      if (tw.spine) { actor.turn('Spine', 'x', 0.4 * tw.spine); actor.turn('Spine1', 'x', 0.35 * tw.spine); actor.turn('Spine2', 'x', 0.25 * tw.spine); }
      if (tw.gripL || tw.gripR) actor.grip?.(tw.gripL || 0, tw.gripR || 0);
      const k = (stage.S / world.ppu) / RANGER_HEIGHT;
      actorState.k = k;
      const a = desc.anchor, a2 = desc.anchor2;
      actor.place({
        yaw: desc.yaw || 0, roll: -(desc.roll || 0), k, z: 0,
        anchor: { joint: a.joint, at: vA.set(wx(a.x), wy(a.y), 0) },
        anchor2: a2 && a2.w > 0 ? { joint: a2.joint, at: vB.set(wx(a2.x), wy(a2.y), 0), w: a2.w } : null,
      });
      // Hanging (or reaching to hang): her shoulders go exactly one arm's length below the grip along her body, so both
      // hands can close on the root at full but natural stretch — the contact is then exact (no floating, no stretching).
      if (desc.hang && (desc.hang.w ?? 1) > 0 && actor.metrics) {
        const h = desc.hang, w = h.w ?? 1;
        actor.world('LeftArm', vS1); actor.world('RightArm', vS2);
        // With the hands spread in depth (see the IK below) part of the arm's reach goes into depth: reach on screen is less.
        const spread = desc.ik?.[0]?.spread || 0, dz = Math.abs(vS1.z - vS2.z) * 0.5 * spread, R = actor.metrics.armReach * k * 0.965;
        const reachW = Math.sqrt(Math.max(0, R * R - dz * dz));
        vS1.add(vS2).multiplyScalar(0.5);
        const tx = wx(h.wrist[0]) + Math.sin(h.phi) * reachW, ty = wy(h.wrist[1]) - Math.cos(h.phi) * reachW;
        actor.root.position.x += (tx - vS1.x) * w; actor.root.position.y += (ty - vS1.y) * w;
        actor.root.updateMatrixWorld(true);
      }
      // Climbing over the top edge: her boots never sink into the glass.
      if (desc.keepAbove) {
        actor.world('LeftFoot', vC); let lx = sx(vC.x), ly = sy(vC.y) + 0.048 * stage.S;
        actor.world('RightFoot', vC); let rx = sx(vC.x), ry = sy(vC.y) + 0.048 * stage.S;
        // A boot fully on inverse kinematics ends at its target: test that, not where the clip pose puts it.
        if (desc.ik) for (const c of desc.ik) {
          if ((c.w ?? 1) < 0.99) continue;
          if (c.limb === 'leftLeg') { lx = c.x; ly = c.y + 0.048 * stage.S; } else if (c.limb === 'rightLeg') { rx = c.x; ry = c.y + 0.048 * stage.S; }
        }
        let lift = 0;
        if (lx < desc.keepAbove.x) lift = Math.max(lift, ly - desc.keepAbove.y);
        if (rx < desc.keepAbove.x) lift = Math.max(lift, ry - desc.keepAbove.y);
        if (lift > 0) { actor.root.position.y += wr(lift); actor.root.updateMatrixWorld(true); }
      }
      // Contacts: hands on the root or the card's edge, boots on the root, hands on the edge beside her when seated.
      if (desc.ik) {
        for (const c of desc.ik) {
          if ((c.w ?? 1) <= 0) continue;
          vP.set(c.pole[0], c.pole[1], c.pole[2]);
          vT.set(wx(c.x), wy(c.y), 0);
          let keep = true;
          if (c.depth === 'hips') { actor.world('Hips', vC); vT.z = vC.z; keep = false; }
          if (c.spread) {
            // Hand out beyond its shoulder in depth (a wider grip): target depth = shoulder + (shoulder - body centre) x spread.
            actor.world(c.limb === 'leftArm' ? 'LeftArm' : 'RightArm', vS1); actor.world(c.limb === 'leftArm' ? 'RightArm' : 'LeftArm', vS2);
            vT.z = vS1.z + (vS1.z - vS2.z) * 0.5 * c.spread; keep = false;
          }
          actor.reach(c.limb, vT, vP, c.w ?? 1, keep);
        }
        // Dev check: how far each fully weighted hand / boot ended up from its contact point (screen px).
        if (contactProbe) {
          contactProbe.length = 0;
          for (const c of desc.ik) {
            if ((c.w ?? 1) < 0.999) continue;
            actor.world(LIMB_END[c.limb], vC);
            contactProbe.push([c.limb, Math.round(Math.hypot(sx(vC.x) - c.x, sy(vC.y) - c.y) * 10) / 10]);
          }
        }
      }
      // Phase 7: the face, then the gear and hair swinging behind her movements (after every contact is placed).
      driveFace(desc, frame, dt);
      actor.secondary?.(dt);
      actor.bones.Hips.localToWorld(vC.copy(actor.harnessLocal || harnessLocal));   // Phase 6: the carabiner on her left hip
      actorState.harness = [sx(vC.x), sy(vC.y)];
    }
    function drawShadows(desc, stage, cardOff) {
      if (desc && actor && desc.treeFeet) {
        // Boots on the banyan root: a soft contact shadow on the bark under them.
        contactShadow.visible = true; legShadow.visible = false;
        contactShadow.position.set(wx(desc.treeFeet[0]), wy(desc.treeFeet[1] + 0.004 * stage.S), -0.6);
        contactShadow.scale.set(wr(0.26 * stage.S), wr(0.045 * stage.S), 1);
        shadowMaterial.opacity = 0.32;
        return;
      }
      if (desc && actor && desc.anchor?.joint === 'origin' && Math.abs(desc.anchor.y - stage.ground) < 2 && !(desc.anchor2?.w > 0.5)) {
        // Running on the forest floor.
        actor.world('Hips', vC);
        contactShadow.visible = true; legShadow.visible = false;
        contactShadow.position.set(vC.x, wy(stage.ground + 0.006 * stage.S), -0.6);
        contactShadow.scale.set(wr(0.42 * stage.S), wr(0.06 * stage.S), 1);
        shadowMaterial.opacity = 0.32;
        return;
      }
      const onCard = desc && actor && (desc.seat || (desc.anchor?.joint !== 'hands' && Math.abs((desc.anchor2?.w ? desc.anchor2.y : desc.anchor.y) - (stage.card.top + cardOff.dy)) < 2));
      if (!onCard) { contactShadow.visible = false; legShadow.visible = false; return; }
      const S = stage.S, top = stage.card.top + cardOff.dy;
      actor.world('Hips', vC);
      const hx = sx(vC.x);
      contactShadow.visible = true;
      contactShadow.position.set(wx(hx), wy(top + 0.004 * S), -0.6);
      contactShadow.scale.set(wr((desc.seat ? 0.5 : 0.36) * S), wr(0.05 * S), 1);
      shadowMaterial.opacity = desc.seat ? 0.3 : 0.22;
      legShadow.visible = !!desc.seat;
      if (desc.seat) {
        legShadow.position.set(wx(hx + 0.03 * S), wy(top + 0.17 * S), -0.6);
        legShadow.scale.set(wr(0.42 * S), wr(0.34 * S), 1);
        legShadow.material.opacity = 0.11;
      }
    }

    // ------------------------------------------------------------ dev-only clip check
    // /login?rangerClip=Ranger_Run[&clipAt=0.3][&clipYaw=0.6][&clipSpeed=1]: the intro is skipped and the named clip
    // plays (looped, or frozen at clipAt seconds) in the real page, on the forest floor beside the card (Sitting: on the
    // card's top edge). window.__zoviveIntro.qa(clip, at, yaw) switches it without reloading.
    const qaParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
    const qa = qaParams?.has('rangerClip') ? {
      clip: qaParams.get('rangerClip'), at: qaParams.has('clipAt') ? Number(qaParams.get('clipAt')) : null,
      yaw: Number(qaParams.get('clipYaw') ?? 0.6), speed: Number(qaParams.get('clipSpeed') ?? 1), skipped: false,
    } : null;
    const camZoom = qaParams?.has('camZoom') ? Number(qaParams.get('camZoom')) : 0;
    const camFocus = qaParams?.get('camFocus') || 'Hips';
    const camLift = Number(qaParams?.get('camLift') ?? 0);
    function qaActor(time, stage) {
      const S = stage.S, c = stage.card;
      const d = Math.max(1e-3, actor?.duration(qa.clip) || 1);
      const t = qa.at !== null ? qa.at : ((time / 1000) * qa.speed) % d;
      if (/Sit/.test(qa.clip)) {
        const x = stage.seat?.x ?? (c.left + c.right) / 2, y = c.top - 0.057 * S;
        return { layers: [{ clip: qa.clip, t, loop: qa.at === null }], yaw: qa.yaw, anchor: { joint: 'Hips', x, y }, hips: [x, y], seat: true };
      }
      const x = Math.max(0.45 * S, c.left - 0.8 * S);
      return { layers: [{ clip: qa.clip, t, loop: qa.at === null }], yaw: qa.yaw, anchor: { joint: 'origin', x, y: stage.ground }, hips: [x, stage.ground - 0.5 * S] };
    }

    // ------------------------------------------------------------ frame
    function renderFrame(time) {
      if (!intro) return null;
      const frame = intro.frame();
      const stage = intro.stage;
      if (qa && stage.S) frame.actor = qaActor(time, stage);
      // Dev-only review camera (?camZoom=4&camFocus=Head&camLift=0.05): zooms onto one of her joints for close-up
      // screenshots; the page itself (DOM card) is not zoomed.
      if (camZoom > 0 && actor) {
        if (actorState.visible) { actor.world(camFocus, vC); camera.position.set(vC.x, vC.y + camLift * actorState.k, 10); }
        camera.zoom = camZoom; camera.updateProjectionMatrix();
      }
      rootMeshes.forEach((m, i) => { const r = frame.roots[i]; if (r) drawRoot(m, r.pts, stage.S, time, r.r); else hideRoot(m); });
      placeCard(frame.card);
      // Time since the last drawn frame, for her secondary motion (0 on the first frame and in reduced motion).
      const fdt = actorState.lastT === null || !time ? 0 : (time - actorState.lastT) / 1000;
      actorState.lastT = time || null;
      driveActor(frame.actor, stage, frame, fdt);
      drawShadows(frame.actor, stage, frame.card);
      drawRope(frame.rope, stage.S, actorState.harness, actorState.k);
      // Once the rope is gone (a quarter second after it comes off her, or the intro skipped) her hip coil goes too.
      if (ropeCoil.length && ropeCoilShown === !!frame.ropeGone) { ropeCoilShown = !frame.ropeGone; ropeCoil.forEach((m) => { m.visible = ropeCoilShown; }); }
      trunkMatte.visible = trunkReady && !!frame.trunkOver;
      // The trunk is never drawn over the card.
      const c = stage.card;
      trunkMaterial.uniforms.uCard.value.set(c.left + frame.card.dx, c.top + frame.card.dy, c.right + frame.card.dx, c.bottom + frame.card.dy);

      // Particles.
      const pList = frame.particles;
      const at = pGeometry.attributes;
      const pp = at.position.array, ps = at.aSize.array, pa = at.aAlpha.array, pk = at.aKind.array, pr = at.aRot.array, pt = at.aTone.array;
      const pn = Math.min(MAX_P, pList.length);
      for (let i = 0; i < pn; i += 1) {
        const p = pList[i], k = clamp(p.life / p.max, 0, 1);
        if (p.tone === undefined) p.tone = (Math.sin(i * 12.9898 + p.max * 78.233) * 43758.5453) % 1;
        pp[i * 3] = wx(p.x); pp[i * 3 + 1] = wy(p.y); pp[i * 3 + 2] = 1;
        const grow = p.kind === 'dust' ? 2.2 - 1.2 * k : 1;
        ps[i] = p.size * dpr * grow;
        pa[i] = p.kind === 'dust' ? k * 0.8 : p.kind === 'leaf' ? Math.min(1, k * 3) : p.kind === 'streak' ? k : Math.min(1, k * 2);
        pk[i] = KIND[p.kind] ?? 0;
        pr[i] = p.rot || 0;
        pt[i] = Math.abs(p.tone);
      }
      pGeometry.setDrawRange(0, pn);
      ['position', 'aSize', 'aAlpha', 'aKind', 'aRot', 'aTone'].forEach((n) => { at[n].needsUpdate = true; });

      const positions = moteGeometry.attributes.position;
      for (let i = 0; i < moteCount; i += 1) {
        positions.array[i * 3] = moteBase[i * 3] + Math.sin(time * 0.00021 + i) * 0.08;
        positions.array[i * 3 + 1] = moteBase[i * 3 + 1] + Math.sin(time * 0.0006 + i * 1.7) * 0.05;
      }
      positions.needsUpdate = true;
      renderer.render(scene, camera);
      frontRenderer.render(frontScene, camera);
      return frame;
    }

    let viewKey = '';
    function relayout() {
      const card = measureCard();
      if (!card) return;
      const key2 = `${world.W}x${world.H}:${Math.round(card.left)}:${Math.round(card.top)}:${Math.round(card.right)}:${Math.round(card.bottom)}`;
      if (key2 === viewKey) return;
      viewKey = key2;
      const field = cardRef.current?.querySelector('.auth-field');
      const inputTop = field ? field.getBoundingClientRect().top - world.top - card.shiftY : undefined;
      const box = { left: card.left, top: card.top, right: card.right, bottom: card.bottom };
      const stage = computeStage({ W: world.W, H: world.H, card: box, blocked: measureBlocked(card), inputTop, trunk: trunkOnScreen(), branch: onScreen(BRANCH_UNDERSIDE), rootPath: onScreen(TREE_ROOT_TOP) });
      // The intro starts from wherever the page put the card; if it is already home (the scene arrived late or the form
      // was used first) there is no tow this time.
      if (!intro && stage.offset) stage.offset = Math.abs(card.shiftX) < 1 && Math.abs(card.shiftY) < 1 ? { dx: 0, dy: 0 } : { dx: card.shiftX, dy: card.shiftY };
      if (!intro) intro = createIntro(stage, { settled: still || callbacks.current.skipIntro || !(stage.offset.dx || stage.offset.dy) });
      else intro.setStage(stage);
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      world.left = rect.left; world.top = rect.top; world.W = rect.width; world.H = rect.height;
      world.ppu = rect.height / WORLD_HEIGHT;
      world.halfW = rect.width / world.ppu / 2;
      const width = world.halfW * 2;
      world.bgW = Math.max(width, WORLD_HEIGHT * BG_ASPECT);
      world.bgH = world.bgW / BG_ASPECT;
      world.bgX = -(world.bgW - width) * 0.34;
      camera.left = -world.halfW; camera.right = world.halfW; camera.top = world.halfH; camera.bottom = -world.halfH; camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
      frontRenderer.setSize(rect.width, rect.height, false);
      dpr = renderer.getPixelRatio();
      background.scale.set(world.bgW, world.bgH, 1); background.position.x = world.bgX;
      trunkMatte.scale.set(world.bgW, world.bgH, 1); trunkMatte.position.set(world.bgX, 0, 5);
      trunkMaterial.uniforms.uScreen.value.set(rect.width, rect.height);
      trunkMaterial.uniforms.uDpr.value = dpr;
      // The CSS backdrop under the canvas shows exactly the same crop, so nothing shifts when the canvas paints.
      const overflow = world.bgW - width;
      const plate = canvas.parentElement?.querySelector('.auth-forest-plate');
      if (plate) plate.style.objectPosition = overflow > 1e-3 ? `${((0.5 - world.bgX / overflow) * 100).toFixed(3)}% 50%` : '50% 50%';
      viewKey = '';
      relayout();
      if (still) renderFrame(0);
    };

    callbacks.current.onCardReveal?.();
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    if (cardRef.current) observer.observe(cardRef.current);
    resize();

    // Using the form ends the intro at once (no waiting for the animation); seated, she looks at the field in use and,
    // otherwise, follows the pointer a little.
    const card = cardRef.current;
    const finishNow = () => intro?.skip();
    const onFocus = (event) => {
      const el = event.target;
      intro?.setFocus(el?.type === 'password' || el?.autocomplete === 'current-password' ? 'password' : el?.tagName === 'INPUT' && el.type !== 'checkbox' ? 'identifier' : null);
      finishNow();
    };
    const onBlur = () => intro?.setFocus(null);
    const onPointer = (event) => intro?.setPointer({ x: event.clientX - world.left, y: event.clientY - world.top });
    const onLeave = () => intro?.setPointer(null);
    card?.addEventListener('pointerdown', finishNow);
    // A click anywhere skips the intro too (the card may still be off screen), and she reacts to the form.
    const screenEl = card?.closest('main');
    screenEl?.addEventListener('pointerdown', finishNow);
    const form = card?.querySelector('form');
    const onSubmit = () => { intro?.react('submit'); actorState.react = { kind: 'submit', t: performance.now() }; };
    form?.addEventListener('submit', onSubmit);
    const errorWatch = new MutationObserver(() => {
      if (card?.querySelector('.auth-error[role="alert"]:not(.auth-connection)')) { intro?.react('error'); actorState.react = { kind: 'error', t: performance.now() }; }
    });
    if (card) errorWatch.observe(card, { childList: true, subtree: true });
    card?.addEventListener('focusin', onFocus);
    card?.addEventListener('focusout', onBlur);
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);

    const params = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
    const debugJoints = () => {
      if (!actor || !actorState.visible) return null;
      const out = {};
      ['Head', 'HeadTop_End', 'Hips', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftLeg', 'RightLeg', 'LeftToe_End', 'RightToe_End', 'LeftForeArm', 'RightForeArm', 'Spine2'].forEach((n) => {
        actor.world(n, vC); out[n] = [Math.round(sx(vC.x)), Math.round(sy(vC.y))];
      });
      return out;
    };
    if (params?.has('introAt') || qa) {
      window.__zoviveIntro = {
        frame: () => intro?.frame(), stage: () => intro?.stage, time: () => intro?.time, world, ready, joints: debugJoints, harness: () => actorState.harness,
        info: () => ({ back: { ...renderer.info.memory, ...renderer.info.render, programs: renderer.info.programs?.length }, front: { ...frontRenderer.info.memory, ...frontRenderer.info.render, programs: frontRenderer.info.programs?.length } }),
        programs: () => [...(frontRenderer.info.programs || []).map((pr) => `front ${pr.name} ${pr.cacheKey.slice(0, 160)}`), ...(renderer.info.programs || []).map((pr) => `back ${pr.name} ${pr.cacheKey.slice(0, 160)}`)],
        ranger: () => actor && {
          legacy: actor.legacy, ankle: actor.ankle, clips: Object.fromEntries(Object.values(actor.clips).map((c) => [c.name, +c.duration.toFixed(3)])),
          morphs: actor.morphMeshes.map((m) => [m.material.name, Array.from(m.morphTargetInfluences, (v) => +v.toFixed(3))]),
          materials: actor.meshes.map((m) => ({ name: m.material.name, type: m.material.type, map: !!m.material.map?.image, size: m.material.map?.image ? [m.material.map.image.width, m.material.map.image.height] : null,
            mr: !!m.material.metalnessMap?.image, sheen: m.material.sheen ?? null, env: m.material.envMapIntensity, morphTargets: m.geometry.morphAttributes.position?.length || 0, vertices: m.geometry.attributes.position.count })),
        },
        qa: qa ? (clip, at = null, yaw = qa.yaw) => { qa.clip = clip; qa.at = at; qa.yaw = yaw; } : null,
        contacts: () => contactProbe && contactProbe.slice(),
        // Light tuning: { hemi, key, fill, rim, rim2, exposure, env, envSkin } (front scene: the ranger, rope, carabiner).
        tune: (o = {}) => {
          [['hemi', frontHemi], ['key', key], ['fill', fill], ['rim', rim], ['rim2', rim2]].forEach(([n, l]) => { if (o[n] !== undefined) l.intensity = o[n]; });
          if (o.exposure !== undefined) frontRenderer.toneMappingExposure = o.exposure;
          if (actor && (o.env !== undefined || o.envSkin !== undefined)) actor.meshes.forEach((m) => { m.material.envMapIntensity = /Skin/.test(m.material.name) ? (o.envSkin ?? m.material.envMapIntensity) : (o.env ?? m.material.envMapIntensity); });
          return { hemi: frontHemi.intensity, key: key.intensity, fill: fill.intensity, rim: rim.intensity, rim2: rim2.intensity, exposure: frontRenderer.toneMappingExposure };
        },
      };
    }

    let completed = false;
    const complete = () => { if (!completed) { completed = true; callbacks.current.onComplete?.(); } };
    const allReady = () => ready.bg && ready.actor !== null;
    // Compile the shaders and upload her textures before she first appears, so nothing stalls a frame.
    let warmed = false;
    const warmUp = () => {
      if (warmed) return;
      warmed = true;
      if (actor) {
        actor.setVisible(true);
        { const restore = showAll(frontScene); frontRenderer.compile(frontScene, camera); restore(); }
        actor.setVisible(true);
        // Upload her textures now, not on the frame she first appears.
        actor.meshes.forEach((mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => {
          Object.values(material).forEach((value) => { if (value && value.isTexture) frontRenderer.initTexture(value); });
        }));
        actor.setVisible(false);
      }
      { const restore = showAll(scene); renderer.compile(scene, camera); restore(); }
      // Then draw everything once to the real canvases, clipped to a single pixel: that uploads her vertex buffers and
      // morph targets, and makes the browser's graphics layer (ANGLE on Windows) finish each shader for the screen.
      // Without it the first frames of the leap, the rope going taut and the first dust each stalled 40–350 ms.
      const prime = (r, sc) => {
        const restore = showAll(sc), culled = [];
        sc.traverse((o) => { if (o.isMesh || o.isPoints) { culled.push([o, o.frustumCulled]); o.frustumCulled = false; } });
        r.setScissorTest(true); r.setScissor(0, 0, 1, 1); r.render(sc, camera); r.setScissorTest(false);
        culled.forEach(([o, c]) => { o.frustumCulled = c; }); restore();
      };
      if (actor) actor.setVisible(true);
      prime(frontRenderer, frontScene); prime(renderer, scene);
      if (actor) actor.setVisible(false);
    };
    // The same, without blocking the page: her shaders compile in parallel (KHR_parallel_shader_compile) while the card
    // still waits off-screen; the intro starts once they are ready. (Synchronous compiling stalled the main thread for
    // up to 0.8 s when the login page mounted again after signing out.)
    let warmState = 'idle';
    // three.js compiles only visible objects: show everything (rope, ring, shadows, particles, roots) for the compile,
    // then restore, so no shader is compiled mid-animation (those were 50–270 ms stalls).
    const showAll = (sc) => { const hidden = []; sc.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } }); return () => hidden.forEach((o) => { o.visible = false; }); };
    const warmUpAsync = () => {
      if (warmState !== 'idle' || !actor) return;
      warmState = 'compiling';
      actor.setVisible(true);
      const restoreFront = showAll(frontScene), restoreBack = showAll(scene);
      const pending = Promise.all([frontRenderer.compileAsync(frontScene, camera), renderer.compileAsync(scene, camera)]);
      restoreFront(); restoreBack();
      actor.setVisible(false);
      const done = () => { if (!disposed) { warmUp(); warmState = 'done'; } };
      pending.then(done, done);
    };
    if (still) {
      complete();
      const settle = () => { if (disposed) return; if (allReady()) warmUp(); renderFrame(0); if (!allReady()) raf = requestAnimationFrame(settle); };
      raf = requestAnimationFrame(settle);
    } else {
      const debugAt = params?.has('introAt') ? Number(params.get('introAt')) : null;
      const debugFreeze = params?.get('introFreeze') === '1';
      let started = false, debugApplied = false, last = performance.now(), lastDraw = 0;
      const waitStart = performance.now();
      // Graceful degradation: the render resolution steps down 0.25× at a time while the average frame takes over
      // ~19 ms, and back up after a few calm seconds — the character's motion is never sped up, skipped or cut short.
      const adapt = (raw) => {
        if (raw > 0.5) return;                                // a hidden tab pauses frames: not slowness
        quality.ema += (raw - quality.ema) * 0.08; quality.frames += 1;
        if (quality.frames < 45) return;
        quality.frames = 0;
        let next = quality.dpr;
        if (quality.ema > 0.019 && quality.dpr > minDpr) { next = Math.max(minDpr, quality.dpr - 0.25); quality.calm = 0; }
        else if (quality.ema < 0.0125 && quality.dpr < maxDpr) { quality.calm += 1; if (quality.calm >= 4) { next = Math.min(maxDpr, quality.dpr + 0.25); quality.calm = 0; } }
        else quality.calm = 0;
        if (next !== quality.dpr) { quality.dpr = next; renderer.setPixelRatio(next); frontRenderer.setPixelRatio(next); resize(); }
      };
      const loop = (now) => {
        if (disposed) return;
        const raw = (now - last) / 1000;
        const dt = Math.min(0.05, raw); last = now;
        if (started) adapt(raw);
        relayout();
        if (!started && (allReady() || now - waitStart > 5000)) warmUpAsync();
        if (!started && (allReady() || now - waitStart > 5000) && (!actor || warmState === 'done' || now - waitStart > 9000)) {
          started = true; warmUp();
          // Her model did not arrive: no intro; the card goes home and the page carries on.
          if (!actor) intro?.skip();
        }
        if (started && intro) {
          if (qa && !qa.skipped) { qa.skipped = true; intro.skip(); }
          if (debugAt !== null && !debugApplied) { debugApplied = true; intro.seek(debugAt); }
          if (!(debugFreeze && debugApplied)) intro.update(dt);
          if (intro.done) complete();
        }
        // Once she is seated (and the card is home) the scene idles at ~30 fps.
        if (!intro?.done || appliedCard.dx || appliedCard.dy || now - lastDraw > 32) { renderFrame(now); lastDraw = now; }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      disposed = true; cancelAnimationFrame(raf); observer.disconnect();
      card?.removeEventListener('pointerdown', finishNow);
      screenEl?.removeEventListener('pointerdown', finishNow);
      form?.removeEventListener('submit', onSubmit);
      errorWatch.disconnect();
      card?.removeEventListener('focusin', onFocus);
      card?.removeEventListener('focusout', onBlur);
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (cardEl) { cardEl.style.transform = ''; cardEl.classList.remove('auth-card-towed'); delete cardEl.dataset.introCard; }
      actor?.release();   // detached, GPU resources freed; the instance itself is kept for the next visit
      const release = (object) => { object.geometry?.dispose?.(); if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose()); else object.material?.dispose?.(); };
      scene.traverse(release); frontScene.traverse(release);
      disposables.forEach((texture) => texture.dispose());
      renderer.dispose(); frontRenderer.dispose();
      if (window.__zoviveIntro) delete window.__zoviveIntro;
    };
  }, [cardRef]);

  return <>
    <canvas ref={canvasRef} className="auth-canopy-canvas" aria-hidden="true" />
    <canvas ref={frontRef} className="auth-canopy-front" aria-hidden="true" />
  </>;
}
