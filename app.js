// ---------- State ----------
let today = new Date();
let STREETS = [];   // real roads near the shopper: [{ id, name, districtId, path: [{lat,lng}] }], set by initMarket()
let plots = [];
let bids = [];
let currentSellerId = SELLERS[0].id;
const makeShopperId = () => `sh_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
const shopperId = (() => {
  try {
    let id = localStorage.getItem("pm-shopper");
    if (!id) { id = makeShopperId(); localStorage.setItem("pm-shopper", id); }
    return id;
  } catch { return makeShopperId(); }
})();
let nominations = { pins: [], mine: [] };
const OCCUPY_RADIUS_M = 20;
const GO_RADIUS_M = 30;
const goShownAt = new Map();
let currentUserPosition = null, activeGoPinId = null, goHideTimer = null, proximityTimer = null, lastProximityCheck = 0;
const CATEGORY_EMOJI = { "Clothing": "👕", "Accessories": "👜", "Food & Drink": "🍽️", "Home": "🛋️", "Books & Music": "📚", "Beauty": "💄", "Other": "🏬" };

const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmt = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const sellerById = (id) => SELLERS.find((s) => s.id === id);
const streetById = (id) => STREETS.find((s) => s.id === id);
const plotById = (id) => plots.find((p) => p.id === id);

// Called by livemap.js once the real roads around the shopper are known. Seeds the demo tenancies onto them.
function initMarket(streets) {
  STREETS = streets;
  bids = [];
  plots = STREETS.flatMap((street) =>
    Array.from({ length: street.plotCount || PLOTS_PER_STREET }, (_, i) => ({
      id: `${street.id}-${i}`, streetId: street.id, position: i, type: "rented",
      status: "empty", sellerId: null, rentPaidUntil: null, auctionEndsAt: null, nominationId: null,
    }))
  );
  const at = (streetIdx, pos) => STREETS[streetIdx] && plotById(`${STREETS[streetIdx].id}-${pos}`);
  for (const [streetIdx, pos, sellerId, months] of INITIAL_TENANCIES) {
    const p = at(streetIdx, pos);
    if (p) Object.assign(p, { status: "taken", sellerId, rentPaidUntil: addMonths(today, months) });
  }
  for (const [streetIdx, position, auctionBids] of INITIAL_AUCTIONS) {
    const auction = at(streetIdx, position);
    if (!auction) continue;
    Object.assign(auction, { status: "auction", auctionEndsAt: addDays(today, AUCTION_DAYS) });
    bids.push(...auctionBids.map((bid) => ({ ...bid, plotId: auction.id, placedAt: new Date(today) })));
  }
  if (typeof LiveMap !== "undefined") applyOccupancy();
  render();
}

// ---------- Core logic ----------
function sellerHasPlotOnStreet(sellerId, streetId) {
  return plots.some((p) => p.streetId === streetId && p.status === "taken" && p.sellerId === sellerId);
}

function rentPlot(plotId, sellerId) {
  const p = plotById(plotId);
  if (p.status === "occupied") return { ok: false, msg: "A real store is already here. Real shops' spots are never for rent." };
  if (p.status !== "empty") return { ok: false, msg: "This plot is not available." };
  if (sellerHasPlotOnStreet(sellerId, p.streetId)) return { ok: false, msg: "You already have a plot on this street (max 1 per street)." };
  Object.assign(p, { status: "taken", sellerId, rentPaidUntil: addMonths(today, 1) });
  return { ok: true, msg: `Rented ${streetById(p.streetId).name} #${p.position + 1} until ${fmt(p.rentPaidUntil)}.` };
}

function payRent(plotId) {
  const p = plotById(plotId);
  p.rentPaidUntil = addMonths(p.rentPaidUntil > today ? p.rentPaidUntil : today, 1);
  return `Rent paid. Protected until ${fmt(p.rentPaidUntil)}.`;
}

function highestBid(plotId) {
  return bids.filter((b) => b.plotId === plotId).sort((a, b) => b.amount - a.amount)[0] || null;
}

function placeBid(plotId, sellerId, amount) {
  const p = plotById(plotId);
  if (p.status === "occupied") return { ok: false, msg: "A real store is already here. Real shops' spots are never for rent." };
  if (p.status !== "auction") return { ok: false, msg: "This plot is not in auction." };
  if (sellerHasPlotOnStreet(sellerId, p.streetId)) return { ok: false, msg: "You already have a plot on this street (max 1 per street)." };
  const top = highestBid(plotId);
  const min = top ? top.amount + 1 : RENT_GBP;
  if (!(amount >= min)) return { ok: false, msg: `Bid must be at least £${min}.` };
  bids.push({ plotId, sellerId, amount, placedAt: new Date(today) });
  return { ok: true, msg: `Bid of £${amount} placed.` };
}

// Runs whenever time moves. Expires rent -> auction; ends auctions -> winner or empty.
function runRentCheck() {
  let expired = 0, settled = 0;
  for (const p of plots) {
    if (p.status === "taken" && p.rentPaidUntil < today) {
      Object.assign(p, { status: "auction", sellerId: null, rentPaidUntil: null, auctionEndsAt: addDays(today, AUCTION_DAYS) });
      expired++;
    }
  }
  for (const p of plots) {
    if (p.status === "auction" && p.auctionEndsAt <= today) {
      const top = highestBid(p.id);
      if (top && !sellerHasPlotOnStreet(top.sellerId, p.streetId)) {
        Object.assign(p, { status: "taken", sellerId: top.sellerId, rentPaidUntil: addMonths(today, 1), auctionEndsAt: null });
      } else {
        Object.assign(p, { status: "empty", auctionEndsAt: null });
      }
      bids = bids.filter((b) => b.plotId !== p.id);
      settled++;
    }
  }
  return { expired, settled };
}

function skipMonth() {
  today = addMonths(today, 1);
  const { expired, settled } = runRentCheck();
  render();
  toast(`Skipped to ${fmt(today)}. ${expired} plot(s) expired, ${settled} auction(s) settled.`);
}

// ---------- Rendering ----------
const $ = (sel) => document.querySelector(sel);
let catalogues = {};
const productsForSeller = (seller) => catalogues[seller.id]?.products ?? seller.products;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function productImage(image, className = "p-img") {
  if (/^https?:/i.test(image || "")) {
    return `<img class="${className}" src="${esc(image)}" alt="" loading="lazy" onerror="imageFallback(this)">`;
  }
  return `<div class="${className}">${esc(image || "🛍️")}</div>`;
}

function imageFallback(image) {
  const placeholder = document.createElement("div");
  placeholder.className = image.className;
  placeholder.textContent = "🛍️";
  image.replaceWith(placeholder);
}

function formatProductPrice(price, currency) {
  if (price == null || !Number.isFinite(Number(price))) return "—";
  const amount = Number(price);
  const code = currency || "GBP";
  if (code === "GBP") return `£${new Intl.NumberFormat("en-GB").format(amount)}`;
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(amount); }
  catch { return `${esc(code)} ${amount}`; }
}

function timeAgo(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

async function importRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadCatalogues() {
  try {
    const response = await fetch("/api/catalogues");
    if (!response.ok) return;
    const data = await response.json();
    catalogues = data && typeof data === "object" ? data : {};
    render();
  } catch { /* catalogues fall back to demo products when unavailable */ }
}

function distanceMetres(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function applyOccupancy() {
  if (typeof LiveMap === "undefined" || typeof LiveMap.plotPosition !== "function") return;
  for (const plot of plots) {
    if (plot.status !== "empty" && plot.status !== "occupied") continue;
    const position = LiveMap.plotPosition(plot.id);
    if (!position) continue;
    const pin = nominations.pins.find((item) => distanceMetres(position, item) <= OCCUPY_RADIUS_M);
    if (pin) Object.assign(plot, { status: "occupied", nominationId: pin.id });
    else if (plot.status === "occupied") Object.assign(plot, { status: "empty", nominationId: null });
  }
}

async function loadNominations() {
  try {
    const response = await fetch(`/api/nominations?shopper=${encodeURIComponent(shopperId)}&seller=${encodeURIComponent(currentSellerId)}`);
    if (!response.ok) return;
    const data = await response.json();
    nominations = { pins: Array.isArray(data.pins) ? data.pins : [], mine: Array.isArray(data.mine) ? data.mine : [] };
    applyOccupancy();
    render();
    if (currentUserPosition) checkProximity(currentUserPosition, true);
  } catch { /* nominations are optional when the server is unavailable */ }
}

function hideGoCard() {
  $("#go-card").classList.add("hidden");
  activeGoPinId = null;
  clearTimeout(goHideTimer);
  goHideTimer = null;
}

function showGoCard(pin) {
  activeGoPinId = pin.id;
  const code = pin.myCode;
  $("#go-card").innerHTML = `<button class="close go-close" id="go-close" aria-label="Close">&times;</button>
    <div class="go-content">${nominationPhoto(pin.id, "go-photo")}<div><b>You're at ${esc(pin.name)}</b><p class="pin-deal"><b>🎁 In-person deal:</b> ${esc(pin.claim.deal.text)}</p>
      ${code ? `<div class="go-code"><code>${esc(code)}</code><small>Show this at the till · one per shopper</small></div>` : `<p class="warn" id="go-error"></p><button class="btn small" id="go-unlock" type="button">Unlock deal</button>`}</div></div>`;
  $("#go-card").classList.remove("hidden");
  $("#go-close").onclick = hideGoCard;
  $("#go-unlock")?.addEventListener("click", (event) => unlockDeal(pin.id, event.currentTarget, true));
  if (code) { clearTimeout(goHideTimer); goHideTimer = setTimeout(hideGoCard, 60_000); }
}

async function unlockDeal(pinId, button, fromCard = false) {
  const position = currentUserPosition || (typeof LiveMap !== "undefined" ? LiveMap.userPosition() : null);
  const target = fromCard ? $("#go-error") : $("#pin-unlock-error");
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/nominations/${encodeURIComponent(pinId)}/deal/unlock`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopperId, lat: position?.lat, lng: position?.lng }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const distance = data.distance != null ? ` (${data.distance} m away)` : "";
      throw new Error(`${data.error || `Request failed (${response.status})`}${distance}`);
    }
    await loadNominations();
    if (fromCard) {
      const pin = nominations.pins.find((item) => item.id === pinId);
      if (pin) showGoCard(pin);
      clearTimeout(goHideTimer);
      goHideTimer = setTimeout(hideGoCard, 60_000);
    } else {
      await loadCatalogues();
      openPin(pinId);
    }
    toast("Deal unlocked");
  } catch (error) {
    if (target) target.textContent = error.message;
    else toast(error.message, true);
    if (button) button.disabled = false;
  }
}

function checkProximity(position, force = false) {
  if (!position) return;
  const now = Date.now();
  if (!force && now - lastProximityCheck < 1000) return;
  lastProximityCheck = now;
  if (activeGoPinId) {
    const active = nominations.pins.find((pin) => pin.id === activeGoPinId);
    if (!active || distanceMetres(position, active) > 80) hideGoCard();
  }
  const nearest = nominations.pins.filter((pin) => pin.status === "claimed" && pin.claim?.deal?.text)
    .map((pin) => ({ pin, distance: distanceMetres(position, pin) }))
    .filter(({ pin, distance }) => distance <= GO_RADIUS_M && now - (goShownAt.get(pin.id) || 0) >= 10 * 60 * 1000)
    .sort((a, b) => a.distance - b.distance)[0];
  if (nearest && !activeGoPinId) {
    goShownAt.set(nearest.pin.id, now);
    showGoCard(nearest.pin);
  }
}

function onUserMove(position) {
  currentUserPosition = { lat: position.lat, lng: position.lng };
  if (activeGoPinId) {
    const active = nominations.pins.find((pin) => pin.id === activeGoPinId);
    if (!active || distanceMetres(currentUserPosition, active) > 80) hideGoCard();
  }
  const delay = 1000 - (Date.now() - lastProximityCheck);
  clearTimeout(proximityTimer);
  if (delay <= 0) checkProximity(currentUserPosition, true);
  else proximityTimer = setTimeout(() => checkProximity(currentUserPosition, true), delay);
}

function registerUserMoves() {
  if (typeof LiveMap === "undefined" || typeof LiveMap.onUserMove !== "function") { setTimeout(registerUserMoves, 50); return; }
  LiveMap.onUserMove(onUserMove);
}

let currentRoutePoints = [];
function formatRouteDistance(distance) {
  return distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1).replace(/\.0$/, "")} km`;
}

function clearRouteCard() {
  currentRoutePoints = [];
  $("#route-card")?.classList.add("hidden");
  document.body.classList.remove("route-open");
}

window.onLiveRouteCleared = clearRouteCard;

async function routeResponse(points) {
  try {
    const query = points.map((point) => `${point.lng},${point.lat}`).join(";");
    const response = await fetch(`/api/route?points=${encodeURIComponent(query)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.path) || data.path.length < 2) throw new Error(data.error || "Route unavailable");
    return { ...data, direct: false };
  } catch {
    const distance = points.slice(1).reduce((sum, point, i) => sum + distanceMetres(points[i], point), 0);
    return { path: points, distance_m: distance, duration_s: distance / 1.4, direct: true };
  }
}

async function routeThrough(points, label, options = {}) {
  const from = currentUserPosition || (typeof LiveMap !== "undefined" ? LiveMap.userPosition() : null);
  if (!from) { toast("Turn on location (or Fake my location) first", true); return null; }
  let stops = Array.isArray(points) ? [...points] : [];
  if (stops[0] && distanceMetres(stops[0], from) < 1) stops.shift();
  const routePoints = [from, ...stops].slice(0, 12);
  if (routePoints.length < 2) { toast("Choose a destination first", true); return null; }
  LiveMap.clearRoute();
  const result = await routeResponse(routePoints);
  const path = [...result.path];
  if (distanceMetres(path[0], routePoints[0]) > 1) path.unshift(routePoints[0]); else path[0] = routePoints[0];
  if (distanceMetres(path.at(-1), routePoints.at(-1)) > 1) path.push(routePoints.at(-1)); else path[path.length - 1] = routePoints.at(-1);
  result.path = path;
  LiveMap.showRoute(path, { destinationIsMarker: options.destinationIsMarker, label });
  currentRoutePoints = path;
  const distance = formatRouteDistance(result.distance_m);
  const minutes = Math.ceil(result.duration_s / 60);
  $("#route-card").innerHTML = `<div class="route-main"><span>${result.direct ? "Direct line · " : "🚶 "}${esc(label)} · ${distance} · ${minutes} min</span></div>
    ${LiveMap.isFakeLocation() ? `<button class="btn small route-walk" id="route-walk" type="button">Walk there</button>` : ""}<button class="ghost route-clear" id="route-clear" type="button" aria-label="Clear route">×</button>`;
  $("#route-card").classList.remove("hidden");
  document.body.classList.add("route-open");
  $("#route-clear").onclick = () => LiveMap.clearRoute();
  $("#route-walk")?.addEventListener("click", async () => {
    const arrived = await LiveMap.followRoute(currentRoutePoints, 1.4, 12_000);
    if (arrived) toast("You reached your destination");
  });
  return result;
}

function routeTo(target, { label = "Walk here", destinationIsMarker = false } = {}) {
  if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)) { toast("Couldn't locate that destination.", true); return Promise.resolve(null); }
  return routeThrough([target], label, { destinationIsMarker });
}

function walkHereButton(position, id = "walk-here") {
  const from = currentUserPosition || (typeof LiveMap !== "undefined" ? LiveMap.userPosition() : null);
  const preview = position && from ? ` · ${formatRouteDistance(distanceMetres(from, position))}` : "";
  return `<button class="btn small walk-here" id="${id}" type="button">Walk here${preview}</button>`;
}

function guidePlots() {
  const snapshot = plots.map(({ id, streetId, position, status, sellerId }) => ({ id, streetId, position, status, sellerId }));
  const byStreet = new Map();
  for (const pin of nominations.pins) {
    let closest = null;
    for (const street of STREETS) {
      for (let index = 0; index < street.path.length; index++) {
        const distance = distanceMetres(pin, street.path[index]);
        if (!closest || distance < closest.distance) closest = { street, index, distance };
      }
    }
    if (!closest || closest.distance > 120) continue;
    const group = byStreet.get(closest.street.id) || [];
    group.push({ pin, ...closest });
    byStreet.set(closest.street.id, group);
  }
  for (const [streetId, group] of byStreet) {
    group.sort((a, b) => a.index - b.index || a.distance - b.distance);
    group.forEach(({ pin }, rank) => snapshot.push({
      id: `pin:${pin.id}`, streetId, position: PLOTS_PER_STREET + rank, status: "pin", sellerId: null,
      pin: { name: pin.name, category: pin.category, streetType: pin.streetType, note: pin.note, claimed: pin.status === "claimed" },
    }));
  }
  return snapshot;
}

// The map itself is drawn by livemap.js (Google Maps); this just refreshes it after state changes.
function render() {
  $("#today").textContent = fmt(today);
  if (typeof refreshLiveMap === "function") refreshLiveMap();
}

function renderProductGrid(products) {
  return `<div class="products">${products.slice(0, 6).map((pr) => {
    const outOfStock = pr.availability === "out_of_stock";
    const url = /^https?:/i.test(pr.url || "") ? pr.url : "#";
    return `<div class="product${outOfStock ? " oos" : ""}">
      ${productImage(pr.image)}
      <div class="p-name">${esc(pr.name)}</div>
      <div class="p-price">${esc(formatProductPrice(pr.price, pr.currency))}</div>
      ${outOfStock ? `<span class="oos-tag">Out of stock</span>` : ""}
      ${pr.variants ? `<div class="p-variants" title="${esc(pr.variants)}">${esc(pr.variants)}</div>` : ""}
      <a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Buy</a>
    </div>`;
  }).join("")}</div>`;
}

function renderImportSection(ownerKey) {
  const imported = catalogues[ownerKey];
  return `<details class="import" ${imported ? "" : "open"}>
    <summary>Import your store</summary>
    <div class="import-row"><input id="import-url" type="url" placeholder="https://your-store.com" value="${esc(imported?.sourceUrl || "")}"><button class="btn" id="import-preview" type="button">Preview</button></div>
    <p class="muted small">Supported today: Shopify stores. Ownership verification coming next.</p>
    <div id="import-result"></div>
    ${imported ? `<button class="btn ghost small" id="import-unpublish" type="button">Remove imported catalogue</button>` : ""}
  </details>`;
}

function importTarget(ownerKey) {
  return ownerKey.startsWith("pin:") ? { pinId: ownerKey.slice(4), sellerId: currentSellerId } : { sellerId: ownerKey };
}

function wireImportSection(ownerKey, reopen) {
  if (!ownerKey) return;
  $("#import-preview")?.addEventListener("click", async (event) => {
    const button = event.currentTarget, result = $("#import-result");
    button.disabled = true;
    button.textContent = "Fetching…";
    try {
      const data = await importRequest("/api/import/preview", { url: $("#import-url").value.trim() });
      const products = Array.isArray(data.products) ? data.products : [];
      result.innerHTML = `<p class="muted small preview-summary"><b>${esc(data.store?.name || "Store")}</b> · ${products.length} products found${data.truncated ? " (showing first 200)" : ""}</p>
        <div class="preview-list">${products.map((pr) => {
          const outOfStock = pr.availability === "out_of_stock";
          const availability = outOfStock ? "Out of stock" : pr.availability === "in_stock" ? "In stock" : "Unknown";
          return `<label><input type="checkbox" data-id="${esc(pr.id)}" ${outOfStock ? "" : "checked"}>${productImage(pr.image, "preview-thumb")}<span class="t">${esc(pr.title)}</span><span class="pr">${esc(formatProductPrice(pr.price, pr.currency))}</span><span class="av${outOfStock ? " out" : ""}">${availability}</span></label>`;
        }).join("")}</div>
        <button class="btn" id="import-publish" type="button">Publish ${products.filter((pr) => pr.availability !== "out_of_stock").length} products</button>`;
      const updateCount = () => {
        const count = result.querySelectorAll(".preview-list input:checked").length;
        result.querySelector("#import-publish").textContent = `Publish ${count} products`;
      };
      result.querySelectorAll(".preview-list input").forEach((checkbox) => checkbox.addEventListener("change", updateCount));
      result.querySelector("#import-publish").addEventListener("click", async (publishEvent) => {
        const publishButton = publishEvent.currentTarget;
        const hidden = Array.from(result.querySelectorAll(".preview-list input:not(:checked)"), (checkbox) => checkbox.dataset.id);
        publishButton.disabled = true;
        publishButton.textContent = "Publishing…";
        try {
          const published = await importRequest("/api/import/publish", { url: $("#import-url").value.trim(), ...importTarget(ownerKey), hidden });
          catalogues[ownerKey] = { ...published.summary, products: published.products };
          await loadCatalogues();
          toast(`Published ${published.summary.visible} products`);
          reopen();
        } catch (error) {
          result.insertAdjacentHTML("afterbegin", `<p class="warn">${esc(error.message)}</p>`);
          publishButton.disabled = false;
          publishButton.textContent = `Publish ${result.querySelectorAll(".preview-list input:checked").length} products`;
        }
      });
    } catch (error) { result.innerHTML = `<p class="warn">${esc(error.message)}</p>`; }
    finally { button.disabled = false; button.textContent = "Preview"; }
  });

  $("#import-unpublish")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await importRequest("/api/import/unpublish", importTarget(ownerKey));
      delete catalogues[ownerKey];
      await loadCatalogues();
      toast("Imported catalogue removed");
      reopen();
    } catch (error) {
      $("#import-result").innerHTML = `<p class="warn">${esc(error.message)}</p>`;
      button.disabled = false;
    }
  });
}

function openPlot(plotId) {
  const p = plotById(plotId);
  const s = streetById(p.streetId);
  const title = `${esc(s.name)} &middot; Plot ${p.position + 1}`;
  let html, importOwnerKey = null, walkTarget = null, walkLabel = "Walk here";
  if (p.status === "occupied") {
    const pin = nominations.pins.find((item) => item.id === p.nominationId);
    walkTarget = pin ? { lat: pin.lat, lng: pin.lng } : LiveMap.plotPosition(p.id);
    walkLabel = pin ? `Walk here · ${pin.name}` : "Walk here · real store";
    html = `<h2>${title}</h2>
      <p class="warn">A real store is already here. Real shops' spots are never for rent.</p>
      ${pin ? `<p class="muted">${esc(pin.category)} · ${esc(pin.streetType)}</p>` : ""}
      <button class="btn" id="view-nominated-store">View ${esc(pin?.name || "store")}</button>${walkHereButton(walkTarget)}`;
  } else if (p.status === "taken") {
    const seller = sellerById(p.sellerId);
    const mine = seller.id === currentSellerId;
    const imported = catalogues[seller.id];
    const products = productsForSeller(seller);
    walkTarget = LiveMap.plotPosition(p.id);
    walkLabel = `Walk here · ${seller.name}`;
    if (mine) importOwnerKey = seller.id;
    html = `
      <div class="shop-head" style="--accent:${esc(seller.color)}">
        <div class="shop-logo">${esc(seller.logo)}</div>
        <div><h2>${esc(seller.name)}</h2><p class="muted">${title}</p><p>${esc(seller.description)}</p></div>
      </div>
      ${renderProductGrid(products)}
      ${walkHereButton(walkTarget)}
      ${imported ? `<p class="muted small">Catalogue from <b>${esc(imported.store?.name || seller.name)}</b> · ${Number(imported.visible ?? imported.products.length)} products · updated ${timeAgo(imported.lastSynced)}</p>` : ""}
      <p class="muted small">Rent paid until <b>${fmt(p.rentPaidUntil)}</b>${p.rentPaidUntil <= addMonths(today, 1) ? " &middot; due soon" : ""}</p>
      ${mine ? `<button class="btn" id="pay-rent">Pay £${RENT_GBP} rent (+1 month)</button>${renderImportSection(seller.id)}` : ""}`;
  } else if (p.status === "empty") {
    const blocked = sellerHasPlotOnStreet(currentSellerId, p.streetId);
    html = `
      <h2>${title}</h2>
      <p class="muted">Empty plot in ${DISTRICTS.find((d) => d.id === s.districtId).name}</p>
      <div class="price">£${RENT_GBP}<span>/month</span></div>
      <ul class="rules">
        <li>Paid up = nobody can take your plot</li>
        <li>Miss rent and the plot goes to auction</li>
        <li>Max 1 plot per street per seller</li>
      </ul>
      <button class="btn" id="rent-plot" ${blocked ? "disabled" : ""}>Rent this plot</button>
      ${blocked ? `<p class="warn">You already have a plot on ${s.name}. Sellers can hold at most one plot per street.</p>` : ""}
      <p class="muted small">Payments are faked for the demo. Stripe in production.</p>`;
  } else {
    const top = highestBid(p.id);
    const blocked = sellerHasPlotOnStreet(currentSellerId, p.streetId);
    const daysLeft = Math.max(0, Math.ceil((p.auctionEndsAt - today) / 86400000));
    const min = top ? top.amount + 1 : RENT_GBP;
    html = `
      <h2>${title}</h2>
      <p class="muted">In auction &middot; ${daysLeft} day${daysLeft === 1 ? "" : "s"} left (ends ${fmt(p.auctionEndsAt)})</p>
      <div class="price">${top ? "£" + top.amount : "No bids"}<span>${top ? " by " + esc(sellerById(top.sellerId).name) : ""}</span></div>
      <div class="bid-row">
        <input type="number" id="bid-amount" min="${min}" step="1" value="${min}" ${blocked ? "disabled" : ""}>
        <button class="btn" id="place-bid" ${blocked ? "disabled" : ""}>Place bid</button>
      </div>
      ${blocked ? `<p class="warn">You already have a plot on ${s.name}, so you can't bid here.</p>` : `<p class="muted small">Minimum bid £${min}. Highest bid when the timer ends wins the plot for one month.</p>`}
      <ol class="bids">${bids.filter((b) => b.plotId === p.id).sort((a, b) => b.amount - a.amount)
        .map((b) => `<li>£${b.amount} &mdash; ${esc(sellerById(b.sellerId).name)}</li>`).join("")}</ol>`;
  }
  $("#modal-body").innerHTML = html;
  $("#modal").classList.remove("hidden");
  wireImportSection(importOwnerKey, () => openPlot(p.id));

  $("#rent-plot")?.addEventListener("click", () => {
    const r = rentPlot(p.id, currentSellerId);
    toast(r.msg, !r.ok); if (r.ok) { render(); openPlot(p.id); }
  });
  $("#pay-rent")?.addEventListener("click", () => { toast(payRent(p.id)); render(); openPlot(p.id); });
  $("#view-nominated-store")?.addEventListener("click", () => openPin(p.nominationId));
  $("#walk-here")?.addEventListener("click", () => { closeModal(); routeTo(walkTarget, { label: walkLabel, destinationIsMarker: true }); });
  $("#place-bid")?.addEventListener("click", () => {
    const r = placeBid(p.id, currentSellerId, Number($("#bid-amount").value));
    toast(r.msg, !r.ok); if (r.ok) { render(); openPlot(p.id); }
  });

}

function nominationPhoto(id, className) {
  const src = `/api/nominations/${encodeURIComponent(id)}/photo`;
  return `<img class="${className}" src="${esc(src)}" alt="Storefront photo" loading="lazy" onerror="nominationImageFallback(this)">`;
}

function nominationImageFallback(image) {
  const placeholder = document.createElement("div");
  placeholder.className = `${image.className} photo-placeholder`;
  placeholder.textContent = "🏬";
  image.replaceWith(placeholder);
}

async function reloadPin(id) {
  await loadNominations();
  await loadCatalogues();
  if (nominations.pins.some((pin) => pin.id === id)) openPin(id);
  else closeModal();
}

async function performClaimAction(id, action, body, message) {
  try {
    const response = await importRequest(`/api/nominations/${encodeURIComponent(id)}/claim${action ? `/${action}` : ""}`, body);
    const toastMessage = typeof message === "function" ? message(response) : message;
    if (toastMessage) toast(toastMessage);
    await reloadPin(id);
    return response;
  } catch (error) {
    $("#claim-start")?.removeAttribute("disabled");
    $("#claim-verify")?.removeAttribute("disabled");
    $("#claim-rent")?.removeAttribute("disabled");
    const target = $("#claim-start-error") || $("#claim-action-error");
    if (target) target.textContent = error.message;
    else toast(error.message, true);
    return null;
  }
}

function claimStartPanel(pin, again = false) {
  return `<button class="btn" id="claim-start-toggle" type="button">${again ? "Claim this store again" : "Is this your store? Claim it"}</button>
    <div id="claim-start-panel" class="claim-start-panel hidden">
      <label class="nomination-field">Website<input id="claim-website" type="url" value="${esc(pin.website || "")}" placeholder="https://your-store.com"></label>
      <p class="muted small">We'll check for a verification tag on your site. No website? An admin can approve your claim manually.</p>
      <p id="claim-start-error" class="warn"></p>
      <button class="btn" id="claim-start" type="button">Start claim</button>
    </div>`;
}

function ownerClaimPanel(pin) {
  const claim = pin.claim;
  if (!claim) return "";
  if (claim.status === "pending_verification") {
    const meta = `<meta name="plot-market-verification" content="${claim.token || ""}">`;
    const txt = `plot-market-verification=${claim.token || ""}`;
    return `<section class="claim-panel"><h3>Verify ownership</h3><p class="muted small">Add either verification record to your website, then check again.</p>
      <p>Meta tag</p><code class="claim-code">${esc(meta)}</code><p>DNS TXT</p><code class="claim-code">${esc(txt)}</code>
      ${claim.failReason ? `<p class="warn">${esc(claim.failReason)}</p>` : ""}<p id="claim-action-error" class="warn"></p>
      <div class="claim-actions"><button class="btn ghost small" id="claim-copy" type="button">Copy token</button><button class="btn" id="claim-verify" type="button">Check now</button><button class="btn ghost small" id="claim-cancel" type="button">Cancel claim</button></div>
    </section>`;
  }
  if (claim.status === "pending_admin") return `<section class="claim-panel"><h3>Waiting for admin approval</h3><p class="muted small">Your claim is in the review queue.</p><p id="claim-action-error" class="warn"></p><button class="btn ghost small" id="claim-cancel" type="button">Cancel claim</button></section>`;
  if (claim.status === "active") {
    const ownerKey = `pin:${pin.id}`;
    return `<section class="claim-panel"><h3>Verified owner · £${RENT_GBP}/month · paid until ${fmt(new Date(claim.rentPaidUntil))}</h3>
      <div class="claim-deal"><label for="claim-deal-text">In-person deal (up to 80 characters)</label><textarea id="claim-deal-text" maxlength="80" rows="2">${esc(claim.deal?.text || "")}</textarea>
        <div class="claim-actions"><button class="btn small" id="claim-deal-save" type="button">Save deal</button><button class="btn ghost small" id="claim-deal-clear" type="button">Clear</button></div></div>
      <p id="claim-action-error" class="warn"></p>
      <div class="claim-actions"><button class="btn" id="claim-rent" type="button">Pay £${RENT_GBP} rent (+1 month)</button>
        <button class="btn ghost small" id="claim-lapse" type="button">Stop paying (demo lapse)</button><button class="btn ghost small" id="claim-remove-store" type="button">Remove my store</button></div>
      ${renderImportSection(ownerKey)}</section>`;
  }
  const label = claim.status === "lapsed" ? "Claim lapsed" : "Claim rejected";
  return `<section class="claim-panel"><h3>${label}</h3>${claim.failReason ? `<p class="warn">${esc(claim.failReason)}</p>` : ""}
    <p id="claim-action-error" class="warn"></p>${claimStartPanel(pin, true)}</section>`;
}

function openPin(id) {
  const pin = nominations.pins.find((item) => item.id === id);
  if (!pin) return;
  const claim = pin.claim;
  const owner = claim?.sellerId === currentSellerId;
  const claimed = pin.status === "claimed" && claim?.status === "active";
  const ownerKey = `pin:${pin.id}`;
  const imported = catalogues[ownerKey];
  const position = currentUserPosition || (typeof LiveMap !== "undefined" ? LiveMap.userPosition() : null);
  const distance = position ? Math.round(distanceMetres(position, pin)) : null;
  let html = `${nominationPhoto(pin.id, "pin-photo")}
    <h2>${esc(pin.name)}</h2><p class="muted">${esc(pin.category)} · ${esc(pin.streetType)}</p>
    ${pin.note ? `<blockquote class="nomination-note">“${esc(pin.note)}”<span>— nominated by a shopper</span></blockquote>` : ""}
    <p><span class="status-chip ${claimed ? "claimed" : "approved"}">${claimed ? "Verified owner" : "Not yet claimed by owner"}</span></p>
    ${pin.website ? `<p><a class="nomination-link" href="${esc(pin.website)}" target="_blank" rel="noopener">Visit website</a></p>` : ""}
    ${walkHereButton({ lat: pin.lat, lng: pin.lng }, "pin-walk-here")}`;
  if (claimed) {
    html += `${renderProductGrid(imported?.products || [])}
      ${imported ? `<p class="muted small">Catalogue from <b>${esc(imported.store?.name || pin.name)}</b> · ${Number(imported.visible ?? imported.products.length)} products · updated ${timeAgo(imported.lastSynced)}</p>` : `<p class="muted small">No products have been published yet.</p>`}
      ${claim.deal?.text ? `<div class="pin-deal"><p><b>🎁 In-person deal:</b> ${esc(claim.deal.text)} — unlocks when you're at the store</p>
        ${pin.myCode ? `<div class="go-code"><code>${esc(pin.myCode)}</code><small>Show this at the till · one per shopper</small></div>` : `<p class="muted small">Get within 30 m to unlock · ${distance == null ? "location unavailable" : `you're ${distance} m away`}</p><button class="btn small" id="pin-unlock" type="button" ${distance == null || distance > GO_RADIUS_M ? "disabled" : ""}>Unlock deal</button><p id="pin-unlock-error" class="warn"></p>`}
      </div>` : ""}`;
  }
  html += `<p class="muted small">Real store: this spot is never for rent.</p>`;
  if (owner) html += ownerClaimPanel(pin);
  else if (!claim || ["lapsed", "rejected"].includes(claim.status)) html += `<section class="claim-panel">${claimStartPanel(pin, Boolean(claim))}</section>`;
  else if (!claimed) html += `<p class="muted small">An owner claim is being reviewed.</p>`;

  $("#modal-body").innerHTML = html;
  $("#modal").classList.remove("hidden");
  $("#pin-walk-here")?.addEventListener("click", () => {
    closeModal();
    routeTo({ lat: pin.lat, lng: pin.lng }, { label: `Walk here · ${pin.name}`, destinationIsMarker: true });
  });
  if (owner && claim?.status === "active") wireImportSection(ownerKey, () => openPin(id));
  $("#claim-start-toggle")?.addEventListener("click", () => $("#claim-start-panel").classList.toggle("hidden"));
  $("#claim-start")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await performClaimAction(id, "", { sellerId: currentSellerId, website: $("#claim-website").value.trim() || null }, "Claim request started");
  });
  $("#claim-copy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(claim.token); toast("Verification token copied"); }
    catch { toast("Copy the token from the verification code above", true); }
  });
  $("#claim-verify")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await performClaimAction(id, "verify", { sellerId: currentSellerId }, (result) => result.ok ? "Store ownership verified" : "Verification token not found yet");
  });
  $("#claim-cancel")?.addEventListener("click", () => performClaimAction(id, "cancel", { sellerId: currentSellerId }, "Claim cancelled"));
  $("#claim-rent")?.addEventListener("click", () => performClaimAction(id, "rent", { sellerId: currentSellerId }, "Rent paid for one month"));
  $("#claim-deal-save")?.addEventListener("click", () => performClaimAction(id, "deal", { sellerId: currentSellerId, text: $("#claim-deal-text").value }, "Deal saved"));
  $("#claim-deal-clear")?.addEventListener("click", () => performClaimAction(id, "deal", { sellerId: currentSellerId, text: null }, "Deal cleared"));
  $("#claim-lapse")?.addEventListener("click", () => {
    if (confirm("Stop paying rent? Your store will become unclaimed and its catalogue and deal will be removed.")) performClaimAction(id, "lapse", { sellerId: currentSellerId }, "Claim lapsed");
  });
  $("#claim-remove-store")?.addEventListener("click", () => {
    if (confirm("Remove your store from the map?")) performClaimAction(id, "remove-store", { sellerId: currentSellerId }, "Store removed");
  });
  $("#pin-unlock")?.addEventListener("click", (event) => unlockDeal(id, event.currentTarget));
}

function openMyNominations() {
  const mine = [...nominations.mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#modal-body").innerHTML = `<h2>My nominations</h2>${mine.length ? `<div class="my-nominations">${mine.map((item) => {
    const status = ["pending", "approved", "claimed", "rejected", "removed"].includes(item.status) ? item.status : "removed";
    return `<article class="my-nomination">
      ${nominationPhoto(item.id, "nomination-thumb")}
      <div class="my-nomination-info"><b>${esc(item.name)}</b><p class="muted small">${esc(item.category)} · ${esc(item.streetType)}</p>
        <span class="status-chip ${status}">${esc(status[0].toUpperCase() + status.slice(1))}</span>
        ${item.status === "rejected" && item.rejectReason ? `<p class="warn">${esc(item.rejectReason)}</p>` : ""}</div>
      <button class="btn small locate-nomination" data-lat="${Number(item.lat)}" data-lng="${Number(item.lng)}" type="button">Locate</button>
    </article>`;
  }).join("")}</div>` : `<p class="muted">You haven't nominated a store yet.</p>`}`;
  $("#modal").classList.remove("hidden");
  $("#modal-body").querySelectorAll(".locate-nomination").forEach((button) => button.addEventListener("click", () => {
    LiveMap.focus({ lat: Number(button.dataset.lat), lng: Number(button.dataset.lng) });
    closeModal();
  }));
}

function openNominateForm(position) {
  const categories = CATEGORIES.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join("");
  const streetTypes = ["Thrift", "Vintage", "Boutique", "Streetwear", "Independent", "Market stall", "Chain", "Café", "Bakery"];
  $("#modal-body").innerHTML = `
    <h2>Nominate a store</h2>
    <p class="muted small">Add a public storefront to the map for shoppers to discover.</p>
    <form id="nomination-form">
      <label class="nomination-field">Store name*<input name="name" required minlength="2" maxlength="60" autocomplete="organization"></label>
      <label class="nomination-field">Category*<select name="category" required><option value="">Choose a category</option>${categories}</select></label>
      <label class="nomination-field">Street type*<input name="streetType" list="street-types" required maxlength="30" autocomplete="off"><datalist id="street-types">${streetTypes.map((type) => `<option value="${esc(type)}">`).join("")}</datalist></label>
      <label class="nomination-field">Storefront photo*<input id="nomination-photo" type="file" accept="image/*" capture="environment" required></label>
      <div id="nomination-photo-preview" class="nomination-photo-preview">Photo preview</div>
      <p class="muted small">Please avoid people's faces in the photo.</p>
      <p id="nomination-photo-error" class="warn"></p>
      <label class="nomination-field">Website<input name="website" type="url" placeholder="https://example.com"></label>
      <label class="nomination-field">Note<textarea name="note" maxlength="120" rows="3"></textarea></label>
      <p class="muted small note-count"><span id="nomination-note-count">0</span>/120</p>
      <label class="public-storefront"><input name="publicStorefront" type="checkbox" required> This is a public storefront (not a home address)</label>
      <input name="lat" type="hidden" value="${Number(position.lat)}"><input name="lng" type="hidden" value="${Number(position.lng)}">
      <p id="nomination-error" class="warn"></p>
      <button class="btn" type="submit">Submit nomination</button>
    </form>`;
  $("#modal").classList.remove("hidden");

  const form = $("#nomination-form");
  let photoData = null;
  form.elements.note.addEventListener("input", () => { $("#nomination-note-count").textContent = form.elements.note.value.length; });
  $("#nomination-photo").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    photoData = null;
    $("#nomination-photo-error").textContent = "";
    $("#nomination-photo-preview").textContent = "Photo preview";
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const resized = canvas.toDataURL("image/jpeg", 0.82);
      if (resized.length > 600 * 1024) throw new Error("That photo is still over 600 KB after resizing. Please choose a smaller image.");
      photoData = resized;
      $("#nomination-photo-preview").innerHTML = `<img src="${esc(resized)}" alt="Storefront preview">`;
    } catch (error) {
      $("#nomination-photo-error").textContent = error.message || "Couldn't read that image. Try another photo.";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = $("#nomination-error"), submit = form.querySelector("button[type=submit]");
    errorEl.textContent = "";
    if (!photoData) { $("#nomination-photo-error").textContent = "Choose a storefront photo under 600 KB after resizing."; return; }
    submit.disabled = true;
    try {
      const response = await fetch("/api/nominations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.elements.name.value, category: form.elements.category.value, streetType: form.elements.streetType.value,
          website: form.elements.website.value || null, note: form.elements.note.value || null,
          lat: Number(form.elements.lat.value), lng: Number(form.elements.lng.value), nominatorId: shopperId,
          publicStorefront: form.elements.publicStorefront.checked, photo: photoData,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      closeModal();
      toast("Nominated! It'll appear once approved.");
      loadNominations();
    } catch (error) {
      errorEl.textContent = error.message;
      submit.disabled = false;
    }
  });
}

function closeModal() { $("#modal").classList.add("hidden"); }

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("error", isError); t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ---------- Wire up ----------
$("#seller-select").innerHTML = SELLERS.map((s) => `<option value="${s.id}">${s.logo} ${s.name}</option>`).join("");
$("#seller-select").onchange = (e) => { currentSellerId = e.target.value; render(); loadNominations(); };
$("#skip-month").onclick = skipMonth;
$("#modal-close").onclick = closeModal;
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
$("#nominate").onclick = () => LiveMap.startPinDrop(openNominateForm);
$("#my-nominations").onclick = openMyNominations;

loadNominations();
setInterval(loadNominations, 15_000);
registerUserMoves();
loadCatalogues();

render(); // streets/plots arrive via initMarket() once the map has found real roads
