// Published catalogues: one per seller, persisted to data/catalogues.json (demo storage; swap for a DB later).
// Also the single place that decides what products a seller shows: imported catalogue if published, else demo data.
const fs = require("fs");
const path = require("path");
const { SELLERS } = require("../data.js");

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "catalogues.json");
let catalogues = {}; // sellerId -> { sourceUrl, route, store, publishedAt, lastSynced, products: [normalised], hidden: [productId] }

function load() {
  try { catalogues = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { catalogues = {}; }
  return catalogues;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(catalogues, null, 2));
}

function publish(sellerId, { sourceUrl, route, store, products, hidden = [] }) {
  const now = new Date().toISOString();
  catalogues[sellerId] = { sourceUrl, route, store, publishedAt: now, lastSynced: now, products, hidden };
  save();
  return summary(sellerId);
}
function unpublish(sellerId) { delete catalogues[sellerId]; save(); }

const visible = (c) => c.products.filter((p) => !c.hidden.includes(p.id));

// What shoppers and the guide see. Imported products are mapped to the shape the rest of the app already uses
// (name/price/image/url/tags/description) plus the new A5 fields.
function productsFor(sellerId) {
  const c = catalogues[sellerId];
  if (c) return visible(c).map((p) => ({ id: p.id, name: p.title, price: p.price, currency: p.currency, image: p.image, url: p.url,
    tags: p.tags, description: p.description, availability: p.availability, variants: p.variants, lastSynced: p.lastSynced, imported: true }));
  if (String(sellerId).startsWith("pin:")) return [];
  const s = SELLERS.find((x) => x.id === sellerId);
  return s ? s.products.map((p) => ({ ...p, currency: "GBP", availability: "in_stock", imported: false })) : [];
}

function summary(sellerId) {
  const c = catalogues[sellerId];
  return c ? { sourceUrl: c.sourceUrl, route: c.route, store: c.store, publishedAt: c.publishedAt, lastSynced: c.lastSynced, total: c.products.length, visible: visible(c).length } : null;
}
const all = () => Object.fromEntries(Object.keys(catalogues).map((id) => [id, { ...summary(id), products: productsFor(id) }]));

load();
module.exports = { publish, unpublish, productsFor, summary, all };
