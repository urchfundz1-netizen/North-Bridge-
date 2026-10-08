/**
 * Sanity-checks the bank illustration: well-formed XML, every `url(#id)`
 * reference resolves, and nothing is drawn outside the viewBox.
 * Run: node scripts/check-svg.mjs
 */
import { readFileSync } from 'node:fs';

const file = new URL('../client/public/bank-head-office.svg', import.meta.url);
const svg = readFileSync(file, 'utf8');

const fail = [];
const note = (msg) => fail.push(msg);

/* 1. Tag balance. */
const tags = [...svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)];
const stack = [];
for (const [, closing, name, , selfClose] of tags) {
  if (selfClose) continue;
  if (closing) {
    const open = stack.pop();
    if (open !== name) note(`tag mismatch: </${name}> closes <${open}>`);
  } else {
    stack.push(name);
  }
}
if (stack.length) note(`unclosed tags: ${stack.join(', ')}`);

/* 2. Gradient / clip-path references all resolve. */
const defined = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) {
  if (!defined.has(m[1])) note(`unresolved reference: url(#${m[1]})`);
}
if (/<(clipPath|mask|pattern)\b/.test(svg)) note('uses a filter/clip element - verify by hand');

/**
 * Points a path actually passes through.
 *
 * A naive scan for `number number` pairs misreads elliptical arcs: in
 * `A 55 55 0 0 1 505 600` the radii, the x-rotation and the two flags are not
 * coordinates, so the naive pairs report an x of 0 and 1 and make the shape
 * look far wider than it is. Arcs are therefore rewritten to keep only their
 * endpoint, and H/V are resolved against the current point.
 */
function pathPoints(d) {
  const points = [];
  let cur = { x: 0, y: 0 };
  const tokens = d.match(/[MmLlHhVvAaCcSsQqTtZz][^MmLlHhVvAaCcSsQqTtZz]*/g) ?? [];
  for (const token of tokens) {
    const cmd = token[0];
    const rest = token.slice(1);
    if (cmd === 'Z' || cmd === 'z') continue;

    if (cmd === 'A' || cmd === 'a') {
      // rx ry x-rotation large-arc-flag sweep-flag x y
      const parts = rest.trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 7 && parts.slice(0, 5).every(Number.isFinite)) {
        const [, , , , , ex, ey] = parts;
        points.push([cmd === 'a' ? cur.x + ex : ex, cmd === 'a' ? cur.y + ey : ey]);
        cur = { x: points.at(-1)[0], y: points.at(-1)[1] };
      }
      continue;
    }

    const nums = rest.trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    if (cmd === 'H' || cmd === 'h') {
      for (const n of nums) {
        cur = { x: cmd === 'h' ? cur.x + n : n, y: cur.y };
        points.push([cur.x, cur.y]);
      }
      continue;
    }
    if (cmd === 'V' || cmd === 'v') {
      for (const n of nums) {
        cur = { x: cur.x, y: cmd === 'v' ? cur.y + n : n };
        points.push([cur.x, cur.y]);
      }
      continue;
    }
    // Everything else is x/y pairs; control points bound the curve anyway.
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const relative = cmd === cmd.toLowerCase();
      const x = relative ? cur.x + nums[i] : nums[i];
      const y = relative ? cur.y + nums[i + 1] : nums[i + 1];
      points.push([x, y]);
      cur = { x, y };
    }
  }
  return points;
}

/* 3. Bounds: every drawn primitive must sit inside the viewBox. */
const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
if (!vb) note('no viewBox');
const [VW, VH] = vb ? [Number(vb[1]), Number(vb[2])] : [0, 0];

const inside = (x0, y0, x1, y1, label) => {
  if (x0 < 0 || y0 < 0 || x1 > VW || y1 > VH) {
    note(`${label} outside viewBox: (${x0},${y0})-(${x1},${y1}) vs ${VW}x${VH}`);
  }
};

const num = (a, k) => Number(a.match(new RegExp(`\\b${k}="(-?[\\d.]+)"`))?.[1] ?? 0);

for (const m of svg.matchAll(/<rect\b([^>]*)>/g)) {
  const a = m[1];
  // The two full-bleed background fills are meant to touch every edge.
  if (/fill="url\(#sky\)"|fill="url\(#glow\)"/.test(a)) continue;
  const x = num(a, 'x');
  const y = num(a, 'y');
  inside(x, y, x + num(a, 'width'), y + num(a, 'height'), `rect x=${x} y=${y}`);
}

for (const m of svg.matchAll(/<circle\b([^>]*)>/g)) {
  const a = m[1];
  const cx = num(a, 'cx');
  const cy = num(a, 'cy');
  const r = num(a, 'r');
  inside(cx - r, cy - r, cx + r, cy + r, `circle ${cx},${cy} r${r}`);
}

for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
  const d = m[1].match(/\bd="([^"]*)"/)?.[1] ?? '';
  const pts = pathPoints(d);
  if (pts.length < 2) continue;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  inside(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), `path ${d.slice(0, 28)}`);
}

/* 4. The engraved wordmark must fit inside the entablature it sits on. */
const textEl = svg.match(/<text\b([^>]*)>([^<]*)<\/text>/);
if (!textEl) {
  note('wordmark <text> not found');
} else {
  const attrs = textEl[1];
  const label = textEl[2];
  const x = Number(attrs.match(/\bx="(-?[\d.]+)"/)?.[1] ?? NaN);
  const size = Number(attrs.match(/\bfont-size="(-?[\d.]+)"/)?.[1] ?? NaN);
  const spacing = Number(attrs.match(/\bletter-spacing="(-?[\d.]+)"/)?.[1] ?? 0);
  const anchor = attrs.match(/\btext-anchor="([\w-]+)"/)?.[1] ?? 'start';

  // Derive the band from the rect behind the text rather than hardcoding it.
  const band = [...svg.matchAll(/<rect\b([^>]*)>/g)]
    .map((m) => m[1])
    .find((a) => /fill="url\(#stoneShade\)"/.test(a) && num(a, 'y') === 496);
  if (!band) {
    note('could not locate the entablature rect behind the wordmark');
  } else {
    const left = num(band, 'x');
    const right = left + num(band, 'width');
    const height = num(band, 'height');

    // Georgia capitals are ~0.62em; letter-spacing follows each glyph.
    const approxWidth = label.length * (size * 0.62 + spacing);
    const start = anchor === 'middle' ? x - approxWidth / 2 : x;
    console.log(
      `wordmark: "${label}" ~${Math.round(approxWidth)}px in a ${right - left}px band, ` +
        `${size}px type in a ${height}px band`,
    );
    if (start < left || start + approxWidth > right) {
      note(`wordmark ~${Math.round(approxWidth)}px overflows the ${right - left}px entablature`);
    }
    if (size > height - 8) note('wordmark type is taller than the entablature leaves room for');
  }
}

if (fail.length) {
  console.error('\nFAILED:');
  for (const f of fail) console.error('  -', f);
  process.exit(1);
}
console.log(`\nOK: well-formed, ${defined.size} ids all resolve, everything inside ${VW}x${VH}`);

/* ------------------------------------------------------------------ */
/* Safe area                                                           */
/*                                                                     */
/* The panel this artwork sits in is frequently narrower than it is    */
/* tall, so `cover` crops the sides hard. Everything inside <g          */
/* id="building"> must therefore survive a band of loss from each edge. */
/* ------------------------------------------------------------------ */

const CROP_TOLERANCE = 0.14; // fraction of the canvas lost per edge, worst case
const pad = Math.round(Math.min(VW, VH) * CROP_TOLERANCE);

/**
 * Extract a `<g>` by id, honouring nesting.
 *
 * A lazy `[\s\S]*?</g>` stops at the first closing tag, which here is a nested
 * column group - it would silently check only the top of the building.
 */
function groupById(id) {
  const open = new RegExp(`<g\\s+id="${id}"\\s*>`).exec(svg);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tags = [...svg.slice(start).matchAll(/<g\b[^>]*>|<\/g>/g)];
  let depth = 1;
  for (const t of tags) {
    depth += t[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return svg.slice(start, start + t.index);
  }
  return null;
}

const group = groupById('building');
if (!group) {
  console.error('\nFAILED: no <g id="building"> to check the safe area against');
  process.exit(1);
}

const xs = [];
const ys = [];
for (const m of group.matchAll(/<rect\b([^>]*)>/g)) {
  xs.push(num(m[1], 'x'), num(m[1], 'x') + num(m[1], 'width'));
  ys.push(num(m[1], 'y'), num(m[1], 'y') + num(m[1], 'height'));
}
for (const m of group.matchAll(/<circle\b([^>]*)>/g)) {
  xs.push(num(m[1], 'cx') - num(m[1], 'r'), num(m[1], 'cx') + num(m[1], 'r'));
  ys.push(num(m[1], 'cy') - num(m[1], 'r'), num(m[1], 'cy') + num(m[1], 'r'));
}
for (const m of group.matchAll(/<path\b([^>]*)>/g)) {
  const d = m[1].match(/\bd="([^"]*)"/)?.[1] ?? '';
  for (const [x, y] of pathPoints(d)) {
    xs.push(x);
    ys.push(y);
  }
}

const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
const problems = [];
if (box.x0 < pad) problems.push(`building left edge ${box.x0} < safe pad ${pad}`);
if (VW - box.x1 < pad) problems.push(`building right margin ${VW - box.x1} < safe pad ${pad}`);
if (box.y0 < pad) problems.push(`building top edge ${box.y0} < safe pad ${pad}`);
if (VH - box.y1 < pad) problems.push(`building bottom margin ${VH - box.y1} < safe pad ${pad}`);

console.log(
  `\nsafe area (${Math.round(CROP_TOLERANCE * 100)}% per edge = ${pad}px):\n` +
    `  building occupies x ${box.x0}-${box.x1}, y ${box.y0}-${box.y1} of ${VW}x${VH}`,
);
if (problems.length) {
  console.error('  FAILED - cropping at a narrow width would clip the building:');
  for (const p of problems) console.error('    -', p);
  process.exit(1);
}
console.log('  OK - the building survives cropping on either axis');