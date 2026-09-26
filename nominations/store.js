const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CATEGORIES, SELLERS } = require("../data.js");

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "nominations.json");
const MAX_PHOTO_BYTES = 600 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const VERIFY_INTERVAL_MS = 20 * 1000;
const UNLOCK_RADIUS_M = 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let records = [];
let lapsedQueue = [];

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    records = Array.isArray(data) ? data : [];
  } catch { records = []; }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
}

function publicRecord(record, sellerId, shopperId) {
  const { photo, ...result } = record;
  const claim = result.claim ? { ...result.claim } : null;
  const myCode = shopperId ? claim?.codes?.[shopperId]?.code : null;
  if (claim) {
    delete claim.codes;
    if (claim.sellerId !== sellerId) delete claim.token;
  }
  return { ...result, flags: [...result.flags], claim, ...(myCode ? { myCode } : {}) };
}

function fail(status, message, extra = {}) {
  throw Object.assign(new Error(message), { status, ...extra });
}

function normaliseName(value) {
  return value.toLowerCase().replace(/\b(?:the|shop|store|ltd)\b/g, " ").replace(/[^a-z0-9]/g, "");
}

function bigrams(value) {
  const result = [];
  for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
  return result;
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a), right = bigrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  for (const gram of left) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) || 0;
    if (count) { overlap++; counts.set(gram, count - 1); }
  }
  return 2 * overlap / (left.length + right.length);
}

function distanceMetres(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function expireLapsedClaims() {
  const now = Date.now(), lapsed = [];
  for (const record of records) {
    const claim = record.claim;
    if (claim?.status !== "active" || !claim.rentPaidUntil || Date.parse(claim.rentPaidUntil) >= now) continue;
    claim.status = "lapsed";
    claim.deal = null;
    claim.codes = {};
    record.status = "approved";
    lapsed.push(record.id);
  }
  if (lapsed.length) { lapsedQueue.push(...lapsed); save(); }
  return lapsed;
}

function takeLapsedIds() {
  const lapsed = lapsedQueue;
  lapsedQueue = [];
  return lapsed;
}

function list({ shopperId, sellerId } = {}) {
  expireLapsedClaims();
  return {
    pins: records.filter((record) => record.status === "approved" || record.status === "claimed").map((record) => publicRecord(record, sellerId, shopperId)),
    mine: records.filter((record) => shopperId && record.nominatorId === shopperId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((record) => publicRecord(record, sellerId, shopperId)),
  };
}

function all() {
  expireLapsedClaims();
  return [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((record) => publicRecord(record));
}

function photo(id) {
  return records.find((record) => record.id === id)?.photo || null;
}

function find(id) {
  const record = records.find((item) => item.id === id);
  if (!record) fail(404, "Nomination not found.");
  return record;
}

function assertOwner(id, sellerId) {
  const record = find(id);
  if (!record.claim || record.claim.sellerId !== sellerId) fail(403, "This claim belongs to a different seller.");
  return record;
}

function validateWebsite(value) {
  if (value == null) return null;
  if (typeof value !== "string") fail(400, "Website must be a valid http or https URL.");
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") fail(400, "Website must use http or https.");
    return url.href;
  } catch (error) {
    if (error.status) throw error;
    fail(400, "Enter a valid http or https website URL.");
  }
}

function create(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const streetType = typeof input.streetType === "string" ? input.streetType.trim() : "";
  const nominatorId = typeof input.nominatorId === "string" ? input.nominatorId.trim() : "";
  if (input.note != null && typeof input.note !== "string") fail(400, "Note must be 120 characters or fewer.");
  const noteInput = typeof input.note === "string" ? input.note.trim() : "";
  const photoData = typeof input.photo === "string" ? input.photo : "";

  if (name.length < 2 || name.length > 60) fail(400, "Name must be 2–60 characters.");
  if (!CATEGORIES.includes(category)) fail(400, "Choose a valid category.");
  if (!streetType || streetType.length > 30) fail(400, "Street type must be 1–30 characters.");
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng) || Math.abs(input.lat) > 90 || Math.abs(input.lng) > 180) fail(400, "A valid latitude and longitude are required.");
  if (input.publicStorefront !== true) fail(400, "Only public storefronts can be nominated.");
  if (noteInput.length > 120) fail(400, "Note must be 120 characters or fewer.");
  if (!nominatorId) fail(400, "nominatorId is required.");
  if (Buffer.byteLength(photoData, "utf8") > MAX_PHOTO_BYTES) fail(400, "Photo must be 600 KB or smaller.");
  const photoMatch = photoData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!photoMatch || !photoMatch[2]) fail(400, "Upload a JPEG, PNG, or WebP photo.");
  const website = validateWebsite(input.website);
  const lat = input.lat, lng = input.lng;

  const now = Date.now();
  if (records.filter((record) => record.nominatorId === nominatorId && now - Date.parse(record.createdAt) < DAY_MS).length >= 5) {
    fail(429, "You can nominate up to 5 stores in 24 hours.");
  }

  const photoHash = crypto.createHash("sha256").update(photoData).digest("hex");
  const normalized = normaliseName(name);
  const flags = [];
  for (const record of records) {
    if (!["rejected", "removed"].includes(record.status) && distanceMetres({ lat, lng }, record) <= 25
      && diceSimilarity(normalized, normaliseName(record.name)) >= 0.6) flags.push(`likely_duplicate:${record.id}`);
    if (record.photoHash === photoHash) flags.push(`duplicate_photo:${record.id}`);
  }

  let id;
  do { id = `n_${crypto.randomBytes(4).toString("hex")}`; } while (records.some((record) => record.id === id));
  const record = {
    id, name, category, streetType, website, note: noteInput || null, lat, lng, nominatorId, publicStorefront: true,
    photo: photoData, photoHash, status: "pending", flags, rejectReason: null, createdAt: new Date(now).toISOString(), decidedAt: null, claim: null,
  };
  records.push(record);
  save();
  return publicRecord(record);
}

function decide(id, status, reason) {
  if (!["approved", "rejected", "removed"].includes(status)) fail(400, "Decision must be approved, rejected, or removed.");
  const record = find(id);
  const rejectReason = typeof reason === "string" ? reason.trim() : "";
  if (status === "rejected" && !rejectReason) fail(400, "A reason is required to reject a nomination.");
  if (record.claim?.status === "active") fail(409, "An actively claimed store must be removed by its owner.");
  if (status !== "approved" && ["pending_admin", "pending_verification"].includes(record.claim?.status)) {
    record.claim.status = "rejected";
    record.claim.failReason = `Store nomination ${status} by an admin.`;
  }
  record.status = status;
  record.rejectReason = status === "rejected" ? rejectReason : null;
  record.decidedAt = new Date().toISOString();
  return saveAndReturn(record);
}

function saveAndReturn(record, sellerId) {
  save();
  return publicRecord(record, sellerId);
}

function addMonth(value) {
  const date = new Date(value);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString();
}

function activate(record) {
  const now = new Date();
  record.claim.status = "active";
  record.claim.verifiedAt = now.toISOString();
  record.claim.rentPaidUntil = addMonth(now);
  record.claim.codes = {};
  record.claim.failReason = null;
  record.status = "claimed";
  record.website ||= record.claim.website;
}

function requestClaim(id, { sellerId, website } = {}) {
  const record = find(id);
  if (!SELLERS.some((seller) => seller.id === sellerId)) fail(400, "A valid sellerId is required.");
  if (website != null && typeof website !== "string") fail(400, "Website must be a valid http or https URL.");
  if (record.status !== "approved") fail(409, "Only approved stores can be claimed.");
  if (["pending_verification", "pending_admin", "active"].includes(record.claim?.status)) fail(409, "This store already has an active claim request.");
  const providedWebsite = typeof website === "string" && website.trim() ? website : record.website;
  const claimWebsite = validateWebsite(providedWebsite);
  const now = new Date().toISOString();
  record.status = "approved";
  record.claim = {
    sellerId, website: claimWebsite, method: claimWebsite ? "meta" : "admin",
    token: `pm-verify-${crypto.randomBytes(6).toString("hex")}`,
    status: claimWebsite ? "pending_verification" : "pending_admin",
    requestedAt: now, verifiedAt: null, rentPaidUntil: null, deal: null, lastChecked: null, failReason: null,
  };
  return saveAndReturn(record, sellerId);
}

async function verifyClaim(id, checker) {
  const record = find(id), claim = record.claim;
  if (!claim || claim.status !== "pending_verification") fail(409, "This claim is not awaiting website verification.");
  if (claim.lastChecked && Date.now() - Date.parse(claim.lastChecked) < VERIFY_INTERVAL_MS) fail(429, "Please wait 20 seconds before checking this claim again.");
  claim.lastChecked = new Date().toISOString();
  save();
  let result;
  try { result = await checker(claim.website, claim.token); }
  catch (error) { result = { ok: false, reason: error.message || "Verification request failed." }; }
  if (result?.ok) activate(record);
  else claim.failReason = result?.reason || "Verification token was not found.";
  save();
  return { ok: Boolean(result?.ok), ...(result?.ok ? {} : { reason: claim.failReason }), pin: publicRecord(record, claim.sellerId) };
}

function decideClaim(id, status) {
  if (!["approved", "rejected"].includes(status)) fail(400, "Claim decision must be approved or rejected.");
  const record = find(id), claim = record.claim;
  if (record.status !== "approved" || !claim || !["pending_admin", "pending_verification"].includes(claim.status)) fail(409, "This claim is not awaiting a decision for an approved store.");
  if (status === "approved") activate(record);
  else {
    claim.status = "rejected";
    claim.failReason = "Claim rejected by an admin.";
    record.status = "approved";
  }
  return saveAndReturn(record);
}

function payClaimRent(id, sellerId) {
  const record = assertOwner(id, sellerId), claim = record.claim;
  if (claim.status !== "active") fail(409, "Only an active owner can pay rent.");
  claim.rentPaidUntil = addMonth(Math.max(Date.now(), Date.parse(claim.rentPaidUntil || 0)));
  return saveAndReturn(record, sellerId);
}

function setDeal(id, sellerId, text) {
  const record = assertOwner(id, sellerId), claim = record.claim;
  if (claim.status !== "active") fail(409, "Only an active owner can set an in-person deal.");
  if (text != null && typeof text !== "string") fail(400, "Deal must be 80 characters or fewer.");
  const deal = typeof text === "string" ? text.trim() : "";
  if (deal.length > 80) fail(400, "Deal must be 80 characters or fewer.");
  claim.deal = deal ? { text: deal } : null;
  return saveAndReturn(record, sellerId);
}

function lapseClaim(id, sellerId) {
  const record = assertOwner(id, sellerId), claim = record.claim;
  if (claim.status !== "active") fail(409, "Only an active owner can stop paying.");
  claim.status = "lapsed";
  claim.deal = null;
  claim.codes = {};
  record.status = "approved";
  return saveAndReturn(record, sellerId);
}

function cancelClaim(id, sellerId) {
  const record = assertOwner(id, sellerId);
  if (!["pending_verification", "pending_admin"].includes(record.claim.status)) fail(409, "Only a pending claim can be cancelled.");
  record.claim = null;
  record.status = "approved";
  return saveAndReturn(record);
}

function removeStore(id, sellerId) {
  const record = assertOwner(id, sellerId), claim = record.claim;
  if (claim.status !== "active") fail(409, "Only an active owner can remove this store.");
  claim.status = "lapsed";
  claim.deal = null;
  claim.codes = {};
  record.status = "removed";
  record.decidedAt = new Date().toISOString();
  return saveAndReturn(record, sellerId);
}

function unlockDeal(id, { shopperId, lat, lng } = {}) {
  const record = find(id), claim = record.claim;
  if (record.status !== "claimed" || claim?.status !== "active" || !claim.deal?.text) fail(404, "No in-person deal here");
  if (typeof shopperId !== "string" || !shopperId.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)
    || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, "shopperId, lat and lng are required.");
  const shopperKey = shopperId.trim();
  const distance = distanceMetres(record, { lat, lng });
  if (distance > UNLOCK_RADIUS_M) fail(403, "You need to be at the store", { distance: Math.round(distance) });
  claim.codes ||= {};
  if (!claim.codes[shopperKey]) {
    const chars = Array.from(crypto.randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
    claim.codes[shopperKey] = { code: `PM-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`, issuedAt: new Date().toISOString() };
    save();
  }
  return { code: claim.codes[shopperKey].code, deal: claim.deal.text, store: record.name };
}

function activeClaim(id) {
  const claim = find(id).claim;
  return claim?.status === "active" ? { ...claim } : null;
}

load();
module.exports = {
  list, all, photo, create, decide, expireLapsedClaims, takeLapsedIds, activeClaim, assertOwner, unlockDeal,
  requestClaim, verifyClaim, decideClaim, payClaimRent, setDeal, lapseClaim, cancelClaim, removeStore, UNLOCK_RADIUS_M,
};
