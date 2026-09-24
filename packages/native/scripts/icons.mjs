/**
 * Draw this app's icon at every size a bundle asks for, from one set of numbers.
 *
 * **Replaces `tauri icon`, which this repository may not run again.**
 * `native-packaging.md` records what it costs: it overwrites
 * `ic_launcher_foreground.png` with the whole badge and rewrites
 * `mipmap-anydpi-v26/ic_launcher.xml` and `values/ic_launcher_background.xml` back
 * to `@mipmap/…` and `#fff`. So this writes **only** the files listed in
 * {@link TARGETS} and {@link ANDROID}, and **no XML**: the two launcher XMLs stay
 * hand-authored, which `nativecheck` asserts from the other side.
 *
 * The Android rasters are drawn here too, with the 72dp a launcher's mask shows
 * standing in for the Dock's tile, so the mark is the same share of both (Q4.128).
 *
 * It also replaces a script that could not run at all: `package.json` said
 * `tauri icon icon.png` and `packages/native/icon.png` has never existed.
 *
 * ## The geometry, and the three numbers that are the platforms'
 *
 * The artwork is `packages/web/public/favicon.svg`, and it is **read off disk
 * rather than retyped** — the mark's six numbers live in three places already
 * (that file, `Mark.tsx`, and the landing repository's own copy), and a fourth
 * would be a fourth to correct. `nativecheck` compares the three that are here.
 *
 * What this adds to it is an **inset**, and that is the whole of the change the
 * app icon needed: the favicon's badge is 192×192 in a 192 viewBox — 100% of its
 * canvas, opaque corner to corner — because a browser tab strip does not mask an
 * icon and a full-bleed badge is right there. macOS *does* mask, and its grid puts
 * an **824×824 squircle in a 1024×1024 canvas**: a 9.77% transparent margin per
 * side. Drawn at 100% the tile reads about a quarter larger in linear terms than
 * every icon beside it in the Dock, which is exactly the report this fixes.
 *
 * So two numbers here are Apple's, one is Android's, and everything else is derived:
 *
 *   {@link MARGIN}           100 / 1024            the transparent margin, as a fraction of the side
 *   {@link RADIUS}           185.4 / 824           the corner, as a fraction of the badge
 *   {@link ADAPTIVE_MARGIN}  (108 - 72) / 2 / 108  what a launcher's mask cuts off each side
 *
 * ⚠ **`RADIUS` is the one place this departs from the favicon rather than scaling
 * it.** The favicon's `rx` is 48 of 192 = 25%; Apple's is 22.5% of the squircle.
 * Scaling the favicon's would give 206 where the grid says 185.4.
 *
 * ⚠ **A circular arc, not a continuous-curvature squircle.** Apple draws a
 * superellipse and a `<path>` would be more faithful. The defect being fixed is
 * **size**, and a corner-curvature change in the same commit makes the before and
 * after unreadable against each other. {@link coverage} is the only thing that
 * would have to change — one inside-test — the day the corner is the complaint.
 *
 * ## Why it rasterizes rather than shelling out
 *
 * There is no ImageMagick, no `rsvg-convert` and no `inkscape` in this tree, and
 * `sips` cannot read an SVG or pad with transparency (`--padColor` is opaque).
 * `iconutil` exists but is macOS's, and this package's scripts run wherever Node
 * does. The shapes are four rounded rectangles, so the rasterizer is a span test
 * and the three containers are all envelopes around PNG payloads — which is less
 * code than a dependency would be configuration, and, unlike a committed binary
 * master, it is a thing a driver can check the arithmetic of.
 *
 * Exact in x — a rounded rect's intersection with a horizontal line is one closed
 * interval — and {@link SUB}-sampled in y, which is where a curve needs it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FAVICON = join(root, "packages/web/public/favicon.svg");
const TAURI = join(root, "packages/native/src-tauri");

/** The transparent margin macOS expects, as a fraction of the canvas side. */
export const MARGIN = 100 / 1024;
/** The corner, as a fraction of the badge — Apple's 185.4 of 824, not the favicon's 25%. */
export const RADIUS = 185.4 / 824;
/**
 * Android's adaptive layer is 108dp and a launcher's mask shows the centre 72dp of it.
 * Treating that 72dp as the badge puts the mark at the Dock's share of the visible
 * shape — 70.6% of its height, 51dp — well inside the 66dp safe circle.
 */
export const ADAPTIVE_MARGIN = (108 - 72) / 2 / 108;
/** Vertical subsamples per pixel. Eight is past the point the corner stops stepping. */
const SUB = 8;

/**
 * The favicon, as numbers.
 *
 * Deliberately strict: every field is required and a miss throws by name. A
 * regex that quietly answers `undefined` for a rewritten attribute would draw a
 * blank tile and pass, which is the one failure mode a generator must not have.
 */
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
    // ⚠ The badge filling its viewBox is what makes this an *inset* rather than a
    // second geometry. If the favicon is ever inset too, the margin below would
    // compound and the tile would shrink twice.
    throw new Error("favicon.svg: the badge no longer fills the viewBox — see this file's header");
  }
  return {
    side,
    ink: badge[4],
    paper: group[1],
    // `scale(.7059)` — a leading dot is legal SVG and `Number(".7059")` reads it.
    mark: { tx: Number(group[2]), ty: Number(group[3]), scale: Number(group[4]) },
    bars,
  };
}

/**
 * The four shapes, in the pixels of a canvas of this size.
 *
 * One composition, scaled about the canvas centre so that the badge lands on
 * the grid `margin` names, then the mark carried along with it. The mark keeps the
 * same fraction of the badge it always had, so nothing about the drawing changes —
 * only how much of the canvas it is allowed to occupy.
 */
function shapesFor(art, size, margin, radius) {
  const badge = size * (1 - 2 * margin);
  const origin = size * margin;
  // SVG units to canvas pixels. The favicon's badge *is* its viewBox, which
  // `readArtwork` refuses to proceed without.
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

/**
 * Where a rounded rectangle starts and stops on one horizontal line.
 *
 * `null` above and below it. Inside the corner bands the inset is the circle's,
 * which is what makes the x axis exact and leaves only y to be sampled.
 */
function span(rect, y) {
  if (y < rect.y || y > rect.y + rect.h) return null;
  const into = Math.min(y - rect.y, rect.y + rect.h - y);
  if (into >= rect.r) return [rect.x, rect.x + rect.w];
  const dy = rect.r - into;
  const inset = rect.r - Math.sqrt(Math.max(0, rect.r * rect.r - dy * dy));
  return [rect.x + inset, rect.x + rect.w - inset];
}

/** How much of the pixel column `[px, px+1]` a span covers. */
function overlap(at, px) {
  if (at === null) return 0;
  return Math.max(0, Math.min(at[1], px + 1) - Math.max(at[0], px));
}

/** One shape's alpha over the whole canvas, as a `Float64Array` of `size²`. */
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

/**
 * The icon at one size, as straight (non-premultiplied) 8-bit RGBA.
 *
 * Source-over, mark on badge on nothing. The bars do not overlap each other —
 * their x ranges are disjoint in the artwork — so their coverages sum rather than
 * needing a union. `badge: false` is Android's foreground: the badge is the
 * background layer's colour there, and the launcher's mask is its shape.
 */
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

/** A PNG chunk: length, type, payload, CRC over type and payload. */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

/** 8-bit RGBA, one `IDAT`, filter type 0 on every row. */
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

/**
 * The macOS container: `icns`, a total length, then typed PNG payloads.
 *
 * ⚠ **No `is32`/`s8mk`/`il32`/`l8mk`.** Those are the legacy 16 and 32px members,
 * RGB plus a separate mask, PackBits-compressed. `tauri.conf.json` pins
 * `minimumSystemVersion` to 13.0 and every member macOS 13 reads is a PNG; `ic11`
 * already covers 32px and the Dock downscales it for 16. Writing an RLE encoder
 * for readers that cannot reach this build would be code with no reader.
 * `nativecheck` pins the member list, so this is a decision on the record rather
 * than something to infer from the bytes.
 */
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

/** The Windows container. A 256 is written as 0, which is the format's own idiom. */
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

/**
 * Every file this writes, and the complete list of them.
 *
 * `icons/ios/*`, `Square*Logo.png` and `StoreLogo.png` are absent: iOS masks its
 * own icons, so full-bleed is right there and this inset would double; a Windows
 * tile sits on a coloured plate and wants a third geometry nobody here has measured.
 */
const TARGETS = { png: [32, 64, 128, 256], icns: ["ic11", 32, "ic12", 64, "ic07", 128, "ic08", 256, "ic13", 256, "ic09", 512, "ic14", 512, "ic10", 1024], ico: [16, 32, 48, 64, 128, 256] };
const NAMED = { 32: "32x32.png", 64: "64x64.png", 128: "128x128.png", 256: "128x128@2x.png" };

/**
 * Android, per density: a 108dp adaptive foreground and 48dp legacy rasters for API
 * 24 and 25, written into both trees so they cannot disagree. `gen/android` is the
 * one a build reads. The legacy square is the Dock's tile; the round one is the same
 * tile as a circle, and nothing names it (the manifest has no `roundIcon`).
 */
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
/** Drawn once per size and variant, however many containers ask for it. */
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
// `icon.png` is the macOS master and is the *same bytes* as the `ic10` member, so
// the file that looks like one is one. `nativecheck` asserts they are identical.
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
