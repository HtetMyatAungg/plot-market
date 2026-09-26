// Import route 1: Shopify's public products endpoint (spec A3).
// Detection: `${origin}/products.json` answers with JSON containing a `products` array.
// Output: normalised products (spec A5), same shape every route must produce.
const { safeFetch, FetchError } = require("./safe-fetch.js");

const PAGE = 250;                 // Shopify's max page size
const MAX_PRODUCTS = 200;         // per-plot cap (A7 "huge stores")
const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "your", "our", "new", "one", "size", "pack", "set"]);

const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const money = (s) => { const n = Number(String(s).replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : null; };

// Tags without an LLM: product type + clean Shopify tags + distinctive title words. Namespaced tags like
// "brand::gender => mens" are reduced to their value.
function deriveTags(p) {
  const out = new Set();
  const add = (t) => { t = String(t).toLowerCase().trim(); if (t && t.length <= 24 && !STOP.has(t)) out.add(t); };
  if (p.product_type) add(p.product_type);
  if (p.vendor) add(p.vendor);
  for (const t of p.tags || []) { const m = String(t).match(/=>\s*(.+)$/); if (m) add(m[1]); else if (!/::|_/.test(t)) add(t); }
  for (const w of String(p.title).toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/)) if (w.length > 3) add(w);
  return [...out].slice(0, 12);
}

function normalise(p, { origin, currency, now }) {
  const variants = p.variants || [];
  const prices = variants.map((v) => money(v.price)).filter((n) => n != null);
  const available = variants.some((v) => v.available);
  const variantSummary = (p.options || []).filter((o) => o.name !== "Title").map((o) => o.values.slice(0, 6).join(", ") + (o.values.length > 6 ? "…" : "")).join(" · ");
  return {
    id: `shopify-${p.id}`,
    title: p.title,
    price: prices.length ? Math.min(...prices) : null,
    currency,
    availability: variants.length ? (available ? "in_stock" : "out_of_stock") : "unknown",
    image: p.images?.[0]?.src || null,
    url: `${origin}/products/${p.handle}`,
    variants: variantSummary || null,
    description: stripHtml(p.body_html).slice(0, 220),
    tags: deriveTags(p),
    source: "shopify",
    lastSynced: now,
  };
}

// Returns null if the store isn't Shopify (or blocks the endpoint), otherwise { store, products }.
async function importShopify(rawUrl) {
  const origin = new URL(rawUrl).origin;
  const probe = await safeFetch(`${origin}/products.json?limit=1`);
  let json;
  try { json = JSON.parse(probe.text); } catch { return null; }
  if (!probe.ok || !Array.isArray(json.products)) return null;

  let store = { name: new URL(origin).hostname, currency: "GBP" };
  try {
    const meta = await safeFetch(`${origin}/meta.json`);
    if (meta.ok) { const m = JSON.parse(meta.text); store = { name: m.name || store.name, currency: m.currency || store.currency }; }
  } catch { /* meta is optional */ }

  const now = new Date().toISOString();
  const products = [];
  for (let page = 1; products.length < MAX_PRODUCTS; page++) {
    const res = await safeFetch(`${origin}/products.json?limit=${PAGE}&page=${page}`);
    if (!res.ok) throw new FetchError(`Store returned ${res.status} while listing products`, 502);
    const batch = JSON.parse(res.text).products || [];
    for (const p of batch) if (p.title && p.handle) products.push(normalise(p, { origin, currency: store.currency, now }));
    if (batch.length < PAGE) break;
  }
  return { route: "shopify", store, products: products.slice(0, MAX_PRODUCTS), truncated: products.length > MAX_PRODUCTS };
}

module.exports = { importShopify, MAX_PRODUCTS };
