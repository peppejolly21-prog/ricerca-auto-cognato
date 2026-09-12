// One-off tool: remove the white background from the car cutout via
// flood-fill from the image borders, so only the true background becomes
// transparent (interior white details like the plate/headlights survive).
import sharp from "sharp";

const SRC = process.argv[2];
const OUT = process.argv[3];

const isBg = (r, g, b) => r > 238 && g > 238 && b > 238;

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

const visited = new Uint8Array(width * height);
const queue = new Int32Array(width * height);
let qHead = 0, qTail = 0;

function tryPush(x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const p = y * width + x;
  if (visited[p]) return;
  const i = p * channels;
  if (isBg(data[i], data[i + 1], data[i + 2])) {
    visited[p] = 1;
    queue[qTail++] = p;
  }
}

for (let x = 0; x < width; x++) { tryPush(x, 0); tryPush(x, height - 1); }
for (let y = 0; y < height; y++) { tryPush(0, y); tryPush(width - 1, y); }

while (qHead < qTail) {
  const p = queue[qHead++];
  const x = p % width, y = (p / width) | 0;
  tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
}

let cleared = 0;
for (let p = 0; p < width * height; p++) {
  if (visited[p]) { data[p * channels + 3] = 0; cleared++; }
}

await sharp(data, { raw: { width, height, channels } }).png().toFile(OUT);

console.log(`Done: ${width}x${height}, ${cleared} bg pixels cleared -> ${OUT}`);
