// Builds dist/index.html by injecting current listings + meta into page_template.html.
//
// Usage: node build.mjs [--known known_ids.json]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const knownFile = argVal("--known");

function sanitizeText(v) {
  if (typeof v !== "string") return v;
  return v
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, (m) => m.slice(0, -1))
    .replace(/�/g, "");
}

function sanitizeListing(l) {
  const out = {};
  for (const [k, v] of Object.entries(l)) out[k] = sanitizeText(v);
  return out;
}

const listings = JSON.parse(readFileSync("./listings.json", "utf8")).map(sanitizeListing);

let knownIds = new Set();
if (knownFile && existsSync(knownFile)) {
  knownIds = new Set(JSON.parse(readFileSync(knownFile, "utf8")));
}

const listingsWithFlags = listings.map((l) => ({
  ...l,
  isNew: knownIds.size > 0 && !knownIds.has(l.id),
}));

const newCount = listingsWithFlags.filter((l) => l.isNew).length;

const data = {
  listings: listingsWithFlags,
  meta: {
    lastRunAt: new Date().toISOString(),
    totalListings: listingsWithFlags.length,
    newCount,
  },
};

const template = readFileSync("./page_template.html", "utf8");
const jsonStr = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
const html = template.replace("/*__APP_DATA__*/", jsonStr);

if (!existsSync("./dist")) mkdirSync("./dist");
writeFileSync("./dist/index.html", html);
if (existsSync("./hero_car.jpg")) copyFileSync("./hero_car.jpg", "./dist/hero_car.jpg");

console.log(`Built dist/index.html — ${listingsWithFlags.length} listings, ${newCount} new.`);

// Save known ids for next run's diff
writeFileSync("./known_ids.json", JSON.stringify(listings.map((l) => l.id)));
