// Car search scraper: Subito.it + AutoScout24.it
// Filters: price 3000-6500 EUR, mileage 0-200000 km, within 100km of Lucca
// Outputs a unified JSON array of normalized listings to stdout / a file.

import { writeFileSync, readFileSync, existsSync } from "fs";
import sharp from "sharp";

const LUCCA = { lat: 43.8429, lon: 10.5027 };
const PRICE_MIN = 3000;
const PRICE_MAX = 6500;
const KM_MAX = 200000;
const RADIUS_KM = 100;

const SUBITO_PROVINCES = ["lucca", "pisa", "livorno", "massa-carrara", "pistoia", "prato", "firenze", "siena"];
const SUBITO_PAGES_PER_PROVINCE = 3; // 30 items/page
const AS24_PAGES = 6; // 19-20 items/page

const GEOCODE_CACHE_FILE = "./geocode_cache.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function loadCache() {
  if (existsSync(GEOCODE_CACHE_FILE)) {
    try {
      return JSON.parse(readFileSync(GEOCODE_CACHE_FILE, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveCache(cache) {
  writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(cache, null, 1));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function geocode(townName, cache) {
  const key = townName.toLowerCase().trim();
  if (cache[key] !== undefined) return cache[key];
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=${encodeURIComponent(
      townName + ", Toscana, Italia"
    )}`;
    const res = await fetch(url, { headers: { "User-Agent": "CarSearchScraper/1.0 (personal use)" } });
    const data = await res.json();
    await sleep(1100); // Nominatim rate limit: 1 req/sec
    if (data && data[0]) {
      const coords = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      cache[key] = coords;
      return coords;
    }
    cache[key] = null;
    return null;
  } catch (e) {
    console.error("Geocode error for", townName, e.message);
    cache[key] = null;
    return null;
  }
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function fetchSubitoProvince(slug) {
  const results = [];
  for (let page = 1; page <= SUBITO_PAGES_PER_PROVINCE; page++) {
    const pageParam = page === 1 ? "" : `&o=${page}`;
    const url = `https://www.subito.it/annunci-toscana/vendita/auto/${slug}/?order=datedesc&ps=${PRICE_MIN}&pe=${PRICE_MAX}&ms=0&me=${KM_MAX}${pageParam}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      const html = await res.text();
      const data = extractNextData(html);
      if (!data) {
        console.error(`Subito ${slug} page ${page}: no NEXT_DATA`);
        break;
      }
      const items = data.props.pageProps.initialState.items;
      const list = items.originalList || [];
      if (list.length === 0) break;
      results.push(...list);
      if (page === 1) {
        console.error(`Subito ${slug}: total=${items.total}, fetched page 1 (${list.length} items)`);
      }
    } catch (e) {
      console.error(`Subito ${slug} page ${page} error:`, e.message);
      break;
    }
    await sleep(500);
  }
  return results;
}

function normalizeSubitoItem(it) {
  const f = it.features || {};
  const getVal = (uri) => (f[uri] && f[uri].values && f[uri].values[0] ? f[uri].values[0].value : null);
  const priceStr = getVal("/price");
  const price = priceStr ? parseInt(priceStr.replace(/[^\d]/g, ""), 10) : null;
  const kmStr = getVal("/mileage_scalar");
  const km = kmStr ? parseInt(kmStr.replace(/[^\d]/g, ""), 10) : null;

  const images = Array.isArray(it.images)
    ? it.images
        .map((img) => (img && img.cdnBaseUrl ? `${img.cdnBaseUrl}?rule=vertical-mini-card-2x-auto` : null))
        .filter(Boolean)
    : [];

  return {
    id: `subito-${it.urn}`,
    source: "Subito.it",
    title: it.subject,
    description: it.body || "",
    images,
    price,
    year: getVal("/year"),
    km,
    fuel: getVal("/fuel"),
    transmission: getVal("/gearbox"),
    condition: getVal("/vehicle_status"),
    carType: getVal("/car_type"),
    comune: it.geo && it.geo.town ? it.geo.town.value : null,
    provincia: it.geo && it.geo.city ? it.geo.city.value : null,
    sellerType: it.advertiser && it.advertiser.company ? "Concessionario" : "Privato",
    sellerName: it.advertiser ? it.advertiser.shopName || it.advertiser.name : null,
    phone: it.advertiser && it.advertiser.phone && it.advertiser.phone !== "0" ? it.advertiser.phone : null,
    date: it.date,
    url: it.urls ? it.urls.default : null,
    distanceKm: null, // filled in later after geocoding
  };
}

async function fetchAS24Page(page) {
  const params = new URLSearchParams({
    priceto: String(PRICE_MAX),
    cy: "I",
    damaged_listing: "exclude",
    powertype: "kw",
    pricefrom: String(PRICE_MIN),
    kmto: String(KM_MAX),
    zip: "55100", // Lucca postal code
    zipr: String(RADIUS_KM),
    ustate: "U",
    sort: "age",
    desc: "0",
    atype: "C",
    page: String(page),
  });
  const url = `https://www.autoscout24.it/lst/cit_lucca?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const html = await res.text();
  const data = extractNextData(html);
  if (!data) {
    console.error(`AS24 page ${page}: no NEXT_DATA`);
    return [];
  }
  const p = data.props.pageProps;
  if (page === 1) {
    console.error(`AS24: total=${p.numberOfResults}, pages=${p.numberOfPages}`);
  }
  return p.listings || [];
}

async function fetchAS24() {
  const all = [];
  for (let page = 1; page <= AS24_PAGES; page++) {
    try {
      const listings = await fetchAS24Page(page);
      if (listings.length === 0) break;
      all.push(...listings);
    } catch (e) {
      console.error(`AS24 page ${page} error:`, e.message);
      break;
    }
    await sleep(500);
  }
  return all;
}

function normalizeAS24Item(l) {
  const v = l.vehicle || {};
  const loc = l.location || {};
  const seller = l.seller || {};
  const tracking = l.tracking || {};
  const price = l.price ? l.price.priceRaw : null;

  const km = tracking.mileage ? parseInt(tracking.mileage, 10) : null;
  const yearMatch = tracking.firstRegistration ? tracking.firstRegistration.match(/\d{4}/) : null;
  const year = yearMatch ? yearMatch[0] : null;

  const phone =
    seller.phones && seller.phones.length ? seller.phones[0].formattedNumber : null;

  const images = Array.isArray(l.images) ? l.images : [];

  return {
    id: `as24-${l.id}`,
    source: "AutoScout24.it",
    title: `${v.make || ""} ${v.modelVersionInput || v.model || ""}`.trim(),
    description: v.subtitle || "",
    images,
    price,
    year,
    km,
    fuel: v.fuel || null,
    transmission: v.transmission || null,
    condition: v.offerType === "N" ? "Nuovo" : "Usato",
    carType: null,
    comune: loc.city || null,
    provincia: null,
    sellerType: seller.type === "Dealer" ? "Concessionario" : "Privato",
    sellerName: seller.companyName || seller.contactName || null,
    phone,
    date: null,
    url: l.url ? `https://www.autoscout24.it${l.url}` : null,
    distanceKm: loc.distanceToSearchLocationInKm != null ? loc.distanceToSearchLocationInKm : null,
  };
}

const PHOTO_CONCURRENCY = 8;
const PHOTO_WIDTH = 320;
const PHOTO_HEIGHT = 240;

async function fetchPhotoDataUri(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length === 0) return null;
    // Re-encode to a small fixed-size JPEG so every photo has a predictable,
    // small footprint once embedded as a data URI in the shared page.
    const jpeg = await sharp(raw)
      .resize(PHOTO_WIDTH, PHOTO_HEIGHT, { fit: "cover" })
      .jpeg({ quality: 55 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

// Artifacts (the shared page) block loading images from external domains,
// so photos must be downloaded here (outside that restriction) and embedded
// as data URIs rather than linked to Subito/AutoScout24's own CDNs.
async function attachPhotos(items) {
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const url = items[i].images && items[i].images[0];
      items[i].photo = url ? await fetchPhotoDataUri(url) : null;
      done++;
      if (done % 100 === 0) console.error(`Photos: ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: PHOTO_CONCURRENCY }, worker));
}

async function main() {
  console.error("=== Fetching AutoScout24 ===");
  const as24Raw = await fetchAS24();
  const as24Items = as24Raw.map(normalizeAS24Item);
  console.error(`AS24: ${as24Items.length} listings normalized`);

  console.error("=== Fetching Subito.it ===");
  const subitoRaw = [];
  for (const slug of SUBITO_PROVINCES) {
    const items = await fetchSubitoProvince(slug);
    subitoRaw.push(...items);
  }
  // Dedup by urn
  const seenUrn = new Set();
  const subitoDeduped = subitoRaw.filter((it) => {
    if (seenUrn.has(it.urn)) return false;
    seenUrn.add(it.urn);
    return true;
  });
  let subitoItems = subitoDeduped.map(normalizeSubitoItem);
  console.error(`Subito: ${subitoItems.length} listings normalized (before geo-filter)`);

  console.error("=== Geocoding Subito comuni ===");
  const cache = loadCache();
  const uniqueComuni = [...new Set(subitoItems.map((i) => i.comune).filter(Boolean))];
  console.error(`Unique comuni to resolve: ${uniqueComuni.length}`);
  for (const comune of uniqueComuni) {
    await geocode(comune, cache);
  }
  saveCache(cache);

  subitoItems = subitoItems
    .map((item) => {
      const coords = item.comune ? cache[item.comune.toLowerCase().trim()] : null;
      if (coords) {
        item.distanceKm = Math.round(haversine(LUCCA.lat, LUCCA.lon, coords.lat, coords.lon) * 10) / 10;
      }
      return item;
    })
    .filter((item) => item.distanceKm === null || item.distanceKm <= RADIUS_KM);

  console.error(`Subito: ${subitoItems.length} listings after 100km geo-filter`);

  const all = [...as24Items, ...subitoItems].filter(
    (i) => i.price != null && i.price >= PRICE_MIN && i.price <= PRICE_MAX
  );

  console.error(`=== TOTAL: ${all.length} listings ===`);

  console.error("=== Downloading photos ===");
  await attachPhotos(all);
  const withPhoto = all.filter((i) => i.photo).length;
  console.error(`Photos embedded: ${withPhoto}/${all.length}`);

  writeFileSync("./listings.json", JSON.stringify(all, null, 1));
  console.error("Saved to listings.json");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
