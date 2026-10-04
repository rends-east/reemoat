/**
 * Draws the app icon at every size a bundle asks for. Replaces `tauri icon`, which rewrites the
 * launcher XMLs and the adaptive foreground: this writes only TARGETS and ANDROID, and no XML.
 * The mark is read off `favicon.svg` and inset to the platforms' grids (native-packaging.md, Q4.128).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FAVICON = join(root, "packages/web/public/favicon.svg");
const TAURI = join(root, "packages/native/src-tauri");

export const MARGIN = 100 / 1024;
/** Apple's corner, not the favicon's 25%: the one number that does not scale. */
export const RADIUS = 185.4 / 824;
/** A launcher shows the centre 72dp of the 108dp layer; treating that as the badge gives the Dock's share. */
export const ADAPTIVE_MARGIN = (108 - 72) / 2 / 108;
const SUB = 8;

/** Strict on purpose: a regex answering `undefined` for a rewritten attribute would draw a blank tile. */
function readArtwork() {
  const svg = readFileSync(FAVICON, "utf8");
  const need = (re, what) => {
    const m = re.exec(svg);
    if (m === null) throw new Error(`favicon.svg: could not read ${what}`);
    return m;
  };
  const view = need(/viewBox="0 0 ([\d.]+) ([\d.]+)"/, "the viewBox");
  const badge = need(/<rect width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="(#[0-9a-f]{6})"\/>/, "the badge");
  const group = need(/<g fill="(#[0-9a-f]{6})" transform="translate\(([\d.]+),([\d.]+)\) scale\(([\d.]*)\)">/, "the mark's transform");
  const bars = [...svg.matchAll(/<rect(?: x="([\d.]+)")?(?: y="([\d.]+)")? width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"\/>/g)]
    .map((m) => ({
      x: Number(m[1] ?? 0),
      y: Number(m[2] ?? 0),
      w: Number(m[3]),
      h: Number(m[4]),
      r: Number(m[5]),
    }));
  if (bars.length !== 3) throw new Error(`favicon.svg: expected three bars, read ${bars.length}`);

  const side = Number(view[1]);
  if (Number(view[2]) !== side) throw new Error("favicon.svg: the viewBox is not square");
  if (Number(badge[1]) !== side || Number(badge[2]) !== side) {
    // An inset favicon would compound with MARGIN and shrink the tile twice.
    throw new Error("favicon.svg: the badge no longer fills the viewBox — see this file's header");
  }
  return {
    side,
    ink: badge[4],
    paper: group[1],
    mark: { tx: Number(group[2]), ty: Number(group[3]), scale: Number(group[4]) },
    bars,
  };
}

function shapesFor(art, size, margin, radius) {
  const badge = size * (1 - 2 * margin);
  const origin = size * margin;
  const f = badge / art.side;
  const s = art.mark.scale * f;
  return {
    ink: { x: origin, y: origin, w: badge, h: badge, r: badge * radius },
    paper: art.bars.map((bar) => ({
      x: origin + (art.mark.tx + bar.x * art.mark.scale) * f,
      y: origin + (art.mark.ty + bar.y * art.mark.scale) * f,
      w: bar.w * s,
      h: bar.h * s,
      r: bar.r * s,
    })),
  };
}

/** Exact in x; only y is subsampled. A circular arc, not Apple's superellipse (native-packaging.md). */
function span(rect, y) {
  if (y < rect.y || y > rect.y + rect.h) return null;
  const into = Math.min(y - rect.y, rect.y + rect.h - y);
  if (into >= rect.r) return [rect.x, rect.x + rect.w];
  const dy = rect.r - into;
  const inset = rect.r - Math.sqrt(Math.max(0, rect.r * rect.r - dy * dy));
  return [rect.x + inset, rect.x + rect.w - inset];
}

function overlap(at, px) {
  if (at === null) return 0;
  return Math.max(0, Math.min(at[1], px + 1) - Math.max(at[0], px));
}

function coverage(rects, size) {
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let s = 0; s < SUB; s += 1) {
      const at = y + (s + 0.5) / SUB;
      for (const rect of rects) {
        const line = span(rect, at);
        if (line === null) continue;
        const from = Math.max(0, Math.floor(line[0]));
        const to = Math.min(size - 1, Math.ceil(line[1]));
        for (let x = from; x <= to; x += 1) out[y * size + x] += overlap(line, x) / SUB;
      }
    }
  }
  return out;
}

const channel = (hex, at) => Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);

/** Straight RGBA. The bars' coverages sum rather than union because their x ranges are disjoint. */
function draw(art, size, { margin = MARGIN, radius = RADIUS, badge = true } = {}) {
  const shapes = shapesFor(art, size, margin, radius);
  const ink = badge ? coverage([shapes.ink], size) : new Float64Array(size * size);
  const paper = coverage(shapes.paper, size);
  const rgba = Buffer.alloc(size * size * 4);
  const back = [channel(art.ink, 0), channel(art.ink, 1), channel(art.ink, 2)];
  const front = [channel(art.paper, 0), channel(art.paper, 1), channel(art.paper, 2)];
  for (let i = 0; i < size * size; i += 1) {
    const aB = Math.min(1, ink[i]);
    const aM = Math.min(1, paper[i]);
    const a = aM + aB * (1 - aM);
    const at = i * 4;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      rgba[at + c] = Math.round((front[c] * aM + back[c] * aB * (1 - aM)) / a);
    }
    rgba[at + 3] = Math.round(a * 255);
  }
  return rgba;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

function png(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** No legacy RGB+mask members: the macOS 13 floor reads only PNG ones, and `nativecheck` pins the list. */
function icns(members) {
  const body = members.map(([type, payload]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(payload.length + 8, 4);
    return Buffer.concat([head, payload]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + body.reduce((sum, one) => sum + one.length, 0), 4);
  return Buffer.concat([head, ...body]);
}

/** A 256 is written as 0, which is the format's own idiom. */
function ico(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let at = dir.length;
  entries.forEach(([size, payload], i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(payload.length, e + 8);
    dir.writeUInt32LE(at, e + 12);
    at += payload.length;
  });
  return Buffer.concat([dir, ...entries.map(([, payload]) => payload)]);
}

/** Complete. iOS masks its own icons and the Windows tiles want an unmeasured geometry, so neither is here. */
const TARGETS = { png: [32, 64, 128, 256], icns: ["ic11", 32, "ic12", 64, "ic07", 128, "ic08", 256, "ic13", 256, "ic09", 512, "ic14", 512, "ic10", 1024], ico: [16, 32, 48, 64, 128, 256] };
const NAMED = { 32: "32x32.png", 64: "64x64.png", 128: "128x128.png", 256: "128x128@2x.png" };

/** Both trees, so they cannot disagree; `gen/android` is the one a build reads. */
const ANDROID = {
  trees: ["icons/android", "gen/android/app/src/main/res"],
  densities: { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 },
  files: {
    "ic_launcher_foreground.png": [108, { margin: ADAPTIVE_MARGIN, badge: false }],
    "ic_launcher.png": [48, {}],
    "ic_launcher_round.png": [48, { radius: 0.5 }],
  },
};

const art = readArtwork();
const made = new Map();
const at = (size, variant = {}) => {
  const key = `${String(size)} ${JSON.stringify(variant)}`;
  const held = made.get(key);
  if (held !== undefined) return held;
  const bytes = png(draw(art, size, variant), size);
  made.set(key, bytes);
  return bytes;
};

const wrote = [];
const put = (name, bytes) => {
  writeFileSync(join(TAURI, name), bytes);
  wrote.push(`${name} ${String(bytes.length)}`);
};

for (const size of TARGETS.png) put(`icons/${NAMED[size]}`, at(size));
// The same bytes as the `ic10` member, which `nativecheck` asserts.
put("icons/icon.png", at(1024));
const members = [];
for (let i = 0; i < TARGETS.icns.length; i += 2) members.push([TARGETS.icns[i], at(TARGETS.icns[i + 1])]);
put("icons/icon.icns", icns(members));
put("icons/icon.ico", ico(TARGETS.ico.map((size) => [size, at(size)])));

for (const tree of ANDROID.trees) {
  for (const [density, scale] of Object.entries(ANDROID.densities)) {
    for (const [name, [dp, variant]] of Object.entries(ANDROID.files)) {
      put(`${tree}/mipmap-${density}/${name}`, at(dp * scale, variant));
    }
  }
}

process.stdout.write(`${wrote.join("\n")}\n`);
