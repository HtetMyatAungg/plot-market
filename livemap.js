// The Plot Market map: real roads near the shopper (OpenStreetMap via /api/roads) become the market's streets,
// with plots as houses on both sides of each road, grouped into four bearing-based quarters. Drawn on Google Maps.
// Also hosts the AI guide's avatar (as a map overlay) and plot highlight effects.
// Depends on globals from data.js (DISTRICTS, SELLERS, PLOTS_PER_STREET, STREETS_PER_DISTRICT, RENT_GBP)
// and app.js (STREETS, plots, currentSellerId, highestBid, openPlot, initMarket, toast).

const LiveMap = (() => {
  const HOUSE_GAP_M = 30;   // spacing between houses along the road
  const SIDE_M = 14;        // house centre distance from the road centre line
  const MIN_SEPARATION_M = 60; // two chosen roads must be at least this far apart (window centres)
  const PER_SIDE = Math.ceil(PLOTS_PER_STREET / 2);
  const FALLBACK = { lat: 51.5074, lng: -0.1278 };    // London, if geolocation is unavailable
  const ZOOM = 18;
  const HOUSE_PATH = "M12 2 L1 11.5 H4 V22 H20 V11.5 H23 Z"; // 24x24 house
  const PIN_PATH = "M12 0C7 0 3 4 3 9c0 6 9 15 9 15s9-9 9-15c0-5-4-9-9-9z";

  let map, userMarker, accuracyCircle, anchor, avatar, toM, toLL, geoWatchId;
  let fakeLocation = false, fakeMapClick, fakeWalkTimer, pinDropActive = false, currentPosition = null;
  let routeShapes = [], routeAnimationTimer = null, routePoints = [], routeDestination = null, followTimer = null, followResolver = null;
  const userMoveListeners = new Set();
  let shapes = [];              // everything drawn, rebuilt on refresh
  const houses = new Map();     // plotId -> marker
  const pinMarkers = new Map(); // pin:<id> -> marker
  const fx = new Map();         // plotId or pin:<id> -> "glow" | "peek"
  const hover = new Set();
  const $ = (sel) => document.querySelector(sel);
  const status = (text) => { const el = $("#live-status"); if (el) el.textContent = text; };
  const streetOf = (p) => STREETS.find((x) => x.id === p.streetId);
  const districtOf = (s) => DISTRICTS.find((d) => d.id === s.districtId);

  // ---------- Geometry (local metres around the anchor) ----------
  function setAnchor(pos) {
    anchor = pos;
    const k = 111320 * Math.cos((pos.lat * Math.PI) / 180);
    toM = (ll) => [(ll.lng - pos.lng) * k, (ll.lat - pos.lat) * 111320];
    toLL = ([x, y]) => ({ lat: pos.lat + y / 111320, lng: pos.lng + x / k });
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Turn a road path into a market street: fit as many house stations as possible into the nearest usable stretch.
  function layoutRoad(road) {
    const pts = road.path.map(toM);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i]);
    const total = cum.at(-1);
    const stationCount = Math.min(PER_SIDE, Math.floor((total - 10) / HOUSE_GAP_M) + 1);
    if (stationCount < 4) return null;
    const windowM = (stationCount - 1) * HOUSE_GAP_M;
    // Arc-length position of the point on the road nearest the shopper (origin).
    let best = { d: Infinity, s: 0 };
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = cum[i] - cum[i - 1];
      const t = len ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / (len * len))) : 0;
      const d = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
      if (d < best.d) best = { d, s: cum[i - 1] + t * len };
    }
    const pointAt = (s) => {
      s = Math.max(0, Math.min(total, s));
      let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / len;
      return { pt: [ax + t * (bx - ax), ay + t * (by - ay)], tan: [(bx - ax) / len, (by - ay) / len], i };
    };
    const start = Math.max(0, Math.min(total - windowM, best.s - windowM / 2));
    const stations = Array.from({ length: stationCount }, (_, k) => pointAt(start + k * HOUSE_GAP_M));
    const a = pointAt(start - 16), b = pointAt(start + windowM + 16);
    const highlight = [a.pt, ...pts.slice(a.i, b.i), b.pt];
    const centre = stations[Math.floor(PER_SIDE / 2)].pt;
    return { ...road, stations, plotCount: stations.length * 2, highlight, sign: pointAt(start - 24).pt, centre };
  }

  // Pick nearby roads in each bearing quadrant, then top up from the remaining nearest roads.
  function chooseStreets(roads) {
    const laid = roads.map(layoutRoad).filter(Boolean);
    const quadrant = (road) => {
      const [x, y] = road.centre, bearing = Math.atan2(y, x);
      if (Math.abs(Math.sin(bearing)) >= Math.abs(Math.cos(bearing))) return y >= 0 ? "north" : "south";
      return x >= 0 ? "east" : "west";
    };
    const candidates = laid.map((road) => ({ ...road, districtId: quadrant(road) }));
    const chosen = [], target = STREETS_PER_DISTRICT * DISTRICTS.length;
    const take = (road) => chosen.push(road);
    const ok = (road) => !chosen.includes(road) && chosen.every((other) => dist(other.centre, road.centre) > MIN_SEPARATION_M);
    for (const district of DISTRICTS) {
      let count = 0;
      for (const road of candidates) {
        if (road.districtId === district.id && count < STREETS_PER_DISTRICT && ok(road)) { take(road); count++; }
      }
    }
    for (const road of candidates) if (chosen.length < target && ok(road)) take(road);
    const used = new Set();
    return chosen.map((road) => {
      let id = road.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "road";
      while (used.has(id)) id += "-2"; used.add(id);
      return { id, name: road.name, districtId: road.districtId, path: road.path, stations: road.stations,
        plotCount: road.plotCount, highlight: road.highlight, sign: road.sign };
    });
  }

  // Synthetic rows cover each quadrant if road data is unavailable.
  function syntheticRoads() {
    const length = (PER_SIDE - 1) * HOUSE_GAP_M + 40;
    return Array.from({ length: STREETS_PER_DISTRICT * DISTRICTS.length }, (_, i) => {
      const districtIndex = Math.floor(i / STREETS_PER_DISTRICT), row = i % STREETS_PER_DISTRICT;
      const offset = 80 + row * 70;
      let path;
      if (districtIndex === 0) path = [toLL([-length / 2, offset]), toLL([length / 2, offset])];
      else if (districtIndex === 1) path = [toLL([offset, -length / 2]), toLL([offset, length / 2])];
      else if (districtIndex === 2) path = [toLL([-length / 2, -offset]), toLL([length / 2, -offset])];
      else path = [toLL([-offset, -length / 2]), toLL([-offset, length / 2])];
      return { name: `${DISTRICTS[districtIndex].name} Row ${row + 1}`, path };
    });
  }

  async function loadStreets(pos) {
    setAnchor(pos);
    status(fakeLocation ? "Fake location · drag or tap to walk" : "Finding roads near you...");
    let roads = [];
    try {
      const r = await fetch(`/api/roads?lat=${pos.lat}&lng=${pos.lng}`);
      if (r.ok) roads = (await r.json()).roads;
    } catch { /* fall through to synthetic */ }
    let streets = chooseStreets(roads);
    if (!streets.length) { streets = chooseStreets(syntheticRoads()); if (!fakeLocation) status("No road data here; using a simple grid."); }
    else if (!fakeLocation) status(`Live · ${streets.length} streets near you`);
    initMarket(streets);
    const b = new google.maps.LatLngBounds();
    for (const p of plots) b.extend(plotCentre(p));
    b.extend(pos);
    map.fitBounds(b, { top: 90, left: 220, right: 60, bottom: 60 });
  }

  const plotCentre = (p) => {
    const s = streetOf(p), st = s.stations[Math.floor(p.position / 2)], side = p.position % 2 ? -1 : 1;
    return toLL([st.pt[0] - st.tan[1] * SIDE_M * side, st.pt[1] + st.tan[0] * SIDE_M * side]);
  };
  const streetStart = (s) => toLL(s.sign);

  const textMarker = (position, text, color, fontSize = "12px", zIndex = 3) => new google.maps.Marker({
    map, position, clickable: false, zIndex,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 },
    label: { text, color, fontSize, fontWeight: "700", className: "map-label" },
  });

  // ---------- Districts: convex hull around each quarter's plots ----------
  function hull(points) {
    const P = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (pts) => { const h = []; for (const p of pts) { while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
    return [...half(P), ...half(P.reverse())];
  }
  function drawDistricts() {
    for (const d of DISTRICTS) {
      const pts = plots.filter((p) => districtOf(streetOf(p)).id === d.id).map((p) => toM(plotCentre(p)));
      for (const s of STREETS.filter((s) => s.districtId === d.id)) pts.push(s.sign, ...s.highlight);
      if (pts.length < 3) continue;
      const h = hull(pts), cx = h.reduce((a, p) => a + p[0], 0) / h.length, cy = h.reduce((a, p) => a + p[1], 0) / h.length;
      const padded = h.map(([x, y]) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + (dx / l) * 34, y + (dy / l) * 34]; });
      shapes.push(new google.maps.Polygon({ map, paths: padded.map(toLL), clickable: false, zIndex: 0,
        fillColor: d.color, fillOpacity: 0.13, strokeColor: d.color, strokeOpacity: 0.8, strokeWeight: 2 }));
      const far = padded.reduce((a, p) => Math.hypot(...p) > Math.hypot(...a) ? p : a, padded[0]);
      shapes.push(textMarker(toLL(far), d.name.toUpperCase(), d.color, "13px", 1));
    }
  }

  // ---------- Streets: highlight the real road + street sign ----------
  function drawStreet(s) {
    const d = districtOf(s), path = s.highlight.map(toLL);
    shapes.push(new google.maps.Polyline({ map, path, clickable: false, zIndex: 1, strokeColor: d.color, strokeOpacity: 0.35, strokeWeight: 22 }));
    shapes.push(new google.maps.Polyline({ map, path, clickable: false, zIndex: 1, strokeColor: "#3a404d", strokeOpacity: 1, strokeWeight: 12 }));
    shapes.push(new google.maps.Polyline({ map, path, clickable: false, zIndex: 1, strokeOpacity: 0,
      icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.7, strokeColor: "#e7e9ee", scale: 2 }, offset: "0", repeat: "16px" }] }));
    shapes.push(textMarker(streetStart(s), s.name, d.color, "12px", 2));
  }

  // ---------- Plots: houses ----------
  function houseIcon(p) {
    const kind = fx.get(p.id), hovered = hover.has(p.id);
    let fill = "#2a2f3a", stroke = "#8b93a5", weight = 1.5, scale = 1.35;
    if (p.status === "taken") {
      const seller = SELLERS.find((x) => x.id === p.sellerId), mine = seller.id === currentSellerId;
      fill = seller.color; stroke = mine ? "#ffffff" : "#0b0d12"; weight = mine ? 2.5 : 1.5; scale = 1.6;
    } else if (p.status === "occupied") { fill = "#1f2937"; stroke = "#38bdf8"; weight = 2.5; scale = 1.6; }
    else if (p.status === "auction") { fill = "#3a2f10"; stroke = "#f59e0b"; weight = 2.5; }
    if (kind === "glow") { stroke = "#fef08a"; weight = 3.5; scale += 0.4; }
    else if (kind === "peek") { stroke = "#ffffff"; weight = 3; scale += 0.25; }
    if (hovered) scale += 0.2;
    return { path: HOUSE_PATH, fillColor: fill, fillOpacity: 1, strokeColor: stroke, strokeWeight: weight, scale,
      anchor: new google.maps.Point(12, 13), labelOrigin: new google.maps.Point(12, 15) };
  }
  function houseLabel(p) {
    if (p.status === "taken") return { text: SELLERS.find((x) => x.id === p.sellerId).logo, fontSize: "14px", className: "map-label" };
    if (p.status === "occupied") return { text: "🏬", fontSize: "11px", className: "map-label" };
    if (p.status === "auction") { const top = highestBid(p.id); return { text: top ? `£${top.amount}` : "Bid", color: "#fbbf24", fontSize: "10px", fontWeight: "700", className: "map-label" };  }
    return { text: String(p.position + 1), color: "#8b93a5", fontSize: "10px", fontWeight: "700", className: "map-label" };
  }
  function pinIcon(pin, id) {
    const kind = fx.get(id), claimed = pin.status === "claimed";
    return { path: PIN_PATH, fillColor: claimed ? "#22c55e" : "#38bdf8", fillOpacity: 1,
      strokeColor: kind === "glow" ? "#fef08a" : kind === "peek" ? "#ffffff" : "#0b0d12",
      strokeWeight: kind ? 3 : 1.5, scale: kind === "glow" ? 1.9 : claimed ? 1.7 : kind === "peek" ? 1.8 : 1.5,
      anchor: new google.maps.Point(12, 24), labelOrigin: new google.maps.Point(12, 9) };
  }
  const restyle = (id) => {
    const p = plots.find((x) => x.id === id), house = houses.get(id);
    if (p && house) { house.setIcon(houseIcon(p)); house.setZIndex(p.status === "occupied" ? 9 : fx.has(id) ? 6 : 4); return; }
    const marker = pinMarkers.get(id), pin = typeof nominations !== "undefined" && nominations.pins.find((item) => `pin:${item.id}` === id);
    if (marker && pin) marker.setIcon(pinIcon(pin, id));
  };

  function drawHouse(p) {
    const s = streetOf(p), seller = p.status === "taken" ? SELLERS.find((x) => x.id === p.sellerId) : null;
    const detail = p.status === "occupied" ? " · real store here (not for rent)" : seller ? ` · ${seller.name}` : p.status === "auction" ? " · in auction" : ` · empty, £${RENT_GBP}/mo`;
    const m = new google.maps.Marker({ map, position: plotCentre(p), icon: houseIcon(p), label: houseLabel(p), zIndex: p.status === "occupied" ? 9 : fx.has(p.id) ? 6 : 4,
      title: `${s.name} #${p.position + 1}${detail}` });
    m.addListener("click", () => openPlot(p.id));
    m.addListener("mouseover", () => { hover.add(p.id); restyle(p.id); });
    m.addListener("mouseout", () => { hover.delete(p.id); restyle(p.id); });
    shapes.push(m); houses.set(p.id, m);
  }

  function drawPin(pin) {
    const id = `pin:${pin.id}`;
    const marker = new google.maps.Marker({ map, position: { lat: pin.lat, lng: pin.lng }, zIndex: 8,
      title: `${pin.name} · ${pin.category} · ${pin.status === "claimed" ? "claimed by owner" : "not yet claimed"}`,
      icon: pinIcon(pin, id),
      label: { text: CATEGORY_EMOJI[pin.category] || CATEGORY_EMOJI.Other, fontSize: "12px", className: "map-label" } });
    marker.addListener("click", () => openPin(pin.id));
    shapes.push(marker); pinMarkers.set(id, marker);
  }

  function drawPendingPin(pin) {
    const marker = new google.maps.Marker({ map, position: { lat: pin.lat, lng: pin.lng }, zIndex: 7, title: "Pending review",
      icon: { path: PIN_PATH, fillColor: "#38bdf8", fillOpacity: 0.35, strokeColor: "#38bdf8", strokeWeight: 2,
        scale: 1.5, anchor: new google.maps.Point(12, 24), labelOrigin: new google.maps.Point(12, 9) },
      label: { text: CATEGORY_EMOJI[pin.category] || CATEGORY_EMOJI.Other, fontSize: "12px", className: "map-label" } });
    shapes.push(marker);
  }

  function refresh() {
    if (!map || !anchor || !STREETS.length) return;
    for (const s of shapes) s.setMap(null);
    shapes = []; houses.clear(); pinMarkers.clear();
    drawDistricts();
    STREETS.forEach(drawStreet);
    plots.forEach(drawHouse);
    if (typeof nominations !== "undefined") {
      nominations.pins.forEach(drawPin);
      nominations.mine.filter((pin) => pin.status === "pending").forEach(drawPendingPin);
    }
  }

  function renderLegend() {
    const el = $("#live-legend"); if (!el) return;
    el.innerHTML = DISTRICTS.map((d) => `<div class="row"><i class="sw district" style="background:${d.color}"></i><span class="district-name">${d.name}</span></div>`).join("")
      + `<div class="sep"></div>
         <div class="row"><i class="sw house taken"></i> Shop (taken)</div>
         <div class="row"><i class="sw house empty"></i> Empty plot</div>
         <div class="row"><i class="sw house auction"></i> In auction</div>
         <div class="row"><i class="sw pin"></i> Real store (nominated)</div>
         <div class="row"><i class="sw pin claimed"></i> Claimed store</div>
         <div class="row"><i class="sw you"></i> You</div>`;
  }

  // ---------- Shopper position ----------
  function setUser(pos, accuracy) {
    const point = pos.toJSON?.() ?? pos;
    currentPosition = { lat: Number(point.lat), lng: Number(point.lng) };
    if (!userMarker) {
      userMarker = new google.maps.Marker({ map, position: currentPosition, title: "You", zIndex: 10,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: "#3b82f6", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 } });
      userMarker.addListener("dragend", () => {
        if (fakeLocation) { const moved = userMarker.getPosition().toJSON(); setUser(moved, 0); map.panTo(moved); }
      });
      accuracyCircle = new google.maps.Circle({ map, center: currentPosition, radius: accuracy || 0, clickable: false,
        fillColor: "#3b82f6", fillOpacity: 0.12, strokeColor: "#3b82f6", strokeOpacity: 0.4, strokeWeight: 1 });
    } else {
      userMarker.setPosition(currentPosition);
      accuracyCircle.setCenter(currentPosition); accuracyCircle.setRadius(accuracy || 0);
    }
    userMarker.setDraggable(fakeLocation);
    for (const listener of userMoveListeners) { try { listener({ ...currentPosition }); } catch { /* one listener must not block location updates */ } }
  }

  function onUserMove(listener) {
    userMoveListeners.add(listener);
    if (currentPosition) listener({ ...currentPosition });
    return () => userMoveListeners.delete(listener);
  }

  function userPosition() { return currentPosition ? { ...currentPosition } : null; }

  function routeDistance(a, b) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function cancelFollowRoute() {
    if (followTimer) clearInterval(followTimer);
    followTimer = null;
    if (followResolver) { const resolve = followResolver; followResolver = null; resolve(false); }
  }

  function clearRoute(notify = true) {
    if (routeAnimationTimer) clearInterval(routeAnimationTimer);
    routeAnimationTimer = null;
    cancelFollowRoute();
    routeShapes.forEach((shape) => shape.setMap(null));
    routeShapes = []; routeDestination = null; routePoints = [];
    if (notify && typeof window.onLiveRouteCleared === "function") window.onLiveRouteCleared();
  }

  function showRoute(points, meta = {}) {
    clearRoute();
    if (!map || !Array.isArray(points) || points.length < 2) return;
    routePoints = points.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
    const casing = new google.maps.Polyline({ map, path: routePoints, clickable: false, zIndex: 2, strokeColor: "#0b0d12", strokeOpacity: 0.9, strokeWeight: 9 });
    const markerSymbol = { path: "M 0,-1 0,1", strokeColor: "#38bdf8", strokeOpacity: 1, scale: 3 };
    const route = new google.maps.Polyline({ map, path: routePoints, clickable: false, zIndex: 3, strokeColor: "#38bdf8", strokeOpacity: 1, strokeWeight: 5,
      icons: [{ icon: markerSymbol, offset: "0px", repeat: "20px" }] });
    routeShapes.push(casing, route);
    let offset = 0;
    routeAnimationTimer = setInterval(() => {
      offset = (offset + 2) % 20;
      route.setOptions({ icons: [{ icon: markerSymbol, offset: `${offset}px`, repeat: "20px" }] });
    }, 60);
    if (!meta.destinationIsMarker) {
      routeDestination = new google.maps.Marker({ map, position: routePoints.at(-1), clickable: false, zIndex: 12,
        title: meta.label || "Destination", icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 },
        label: { text: "🏁", fontSize: "18px", className: "map-label" } });
      routeShapes.push(routeDestination);
    }
    const bounds = new google.maps.LatLngBounds();
    routePoints.forEach((point) => bounds.extend(point));
    if (currentPosition) bounds.extend(currentPosition);
    map.fitBounds(bounds, { top: 90, right: 70, bottom: 120, left: 70 });
    google.maps.event.addListenerOnce(map, "idle", () => map.setZoom(Math.max(15, Math.min(18, map.getZoom() || ZOOM))));
  }

  function followRoute(points, speedMps = 1.4, maxMs = 12000) {
    if (!fakeLocation || !currentPosition || !Array.isArray(points) || points.length < 2) return Promise.resolve(false);
    cancelFollowRoute();
    const path = points.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
    if (routeDistance(currentPosition, path[0]) > 0.5) path.unshift({ ...currentPosition });
    else path[0] = { ...currentPosition };
    const lengths = path.slice(1).map((point, i) => routeDistance(path[i], point));
    const cumulative = [0];
    lengths.forEach((length) => cumulative.push(cumulative.at(-1) + length));
    const total = cumulative.at(-1), duration = Math.min(maxMs, total / Math.max(speedMps, 0.1) * 1000);
    return new Promise((resolve) => {
      followResolver = resolve;
      const finish = (arrived) => {
        if (followTimer) clearInterval(followTimer);
        followTimer = null; followResolver = null;
        if (arrived) { setUser(path.at(-1), 0); map.panTo(path.at(-1)); }
        resolve(arrived);
      };
      if (!duration) { finish(true); return; }
      const started = Date.now();
      followTimer = setInterval(() => {
        const progress = Math.min(1, (Date.now() - started) / duration);
        let targetDistance = total * progress, segment = 0;
        while (segment < lengths.length - 1 && cumulative[segment + 1] < targetDistance) segment++;
        const ratio = lengths[segment] ? Math.min(1, (targetDistance - cumulative[segment]) / lengths[segment]) : 1;
        const from = path[segment], to = path[segment + 1];
        const point = { lat: from.lat + (to.lat - from.lat) * ratio, lng: from.lng + (to.lng - from.lng) * ratio };
        setUser(point, 0); map.panTo(point);
        if (progress >= 1) finish(true);
      }, 200);
    });
  }

  function walkTo(target) {
    if (!fakeLocation || !currentPosition) return;
    cancelFollowRoute();
    clearInterval(fakeWalkTimer);
    const from = { ...currentPosition }, metres = distanceMetres(from, target), duration = Math.min(3000, metres / 1.4 * 1000);
    if (duration <= 0) { setUser(target, 0); return; }
    const started = Date.now();
    fakeWalkTimer = setInterval(() => {
      if (!fakeLocation) { clearInterval(fakeWalkTimer); return; }
      const progress = Math.min(1, (Date.now() - started) / duration);
      const position = { lat: from.lat + (target.lat - from.lat) * progress, lng: from.lng + (target.lng - from.lng) * progress };
      setUser(position, 0);
      map.panTo(position);
      if (progress >= 1) clearInterval(fakeWalkTimer);
    }, 200);
  }

  function toggleFakeLocation() {
    if (!map) return;
    fakeLocation = !fakeLocation;
    const button = $("#fake-location");
    if (fakeLocation) {
      if (!currentPosition) setUser(map.getCenter()?.toJSON?.() || FALLBACK, 0);
      if (!STREETS.length) { map.setCenter(currentPosition); loadStreets(currentPosition); }
      userMarker.setDraggable(true);
      status("Fake location · drag or tap to walk");
      button.textContent = "Real location";
      fakeMapClick = map.addListener("click", (event) => { if (!pinDropActive) walkTo(event.latLng.toJSON()); });
    } else {
      cancelFollowRoute();
      clearInterval(fakeWalkTimer);
      if (fakeMapClick) google.maps.event.removeListener(fakeMapClick);
      fakeMapClick = null;
      userMarker?.setDraggable(false);
      button.textContent = "Fake my location";
      startGeolocation();
    }
  }

  async function anchorHere() {
    if (!userMarker) return;
    clearRoute();
    await loadStreets(userMarker.getPosition().toJSON());
    if (typeof toast === "function") toast("Streets re-laid on the roads around you (demo tenancies reset).");
  }

  function startGeolocation() {
    if (geoWatchId != null) navigator.geolocation?.clearWatch(geoWatchId);
    geoWatchId = null;
    const useFallback = (msg) => { if (fakeLocation) return; status(msg); setUser(FALLBACK); map.setCenter(FALLBACK); loadStreets(FALLBACK); };
    if (!navigator.geolocation) return useFallback("Geolocation not supported; showing London.");
    status("Locating you...");
    let first = true;
    geoWatchId = navigator.geolocation.watchPosition(
      (g) => {
        if (fakeLocation) return;
        const pos = { lat: g.coords.latitude, lng: g.coords.longitude };
        setUser(pos, g.coords.accuracy);
        if (first) { first = false; map.setCenter(pos); loadStreets(pos); }
      },
      (e) => { if (!fakeLocation && first) { first = false; useFallback(e.code === e.PERMISSION_DENIED ? "Location denied; showing London." : `Location error: ${e.message}`); } },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  // ---------- Guide avatar (DOM element hosted in a map overlay so it pans/zooms with the map) ----------
  function makeAvatarOverlay(el) {
    class AvatarOverlay extends google.maps.OverlayView {
      constructor() { super(); this.pos = null; }
      onAdd() { this.getPanes().floatPane.appendChild(el); }
      onRemove() { el.remove(); }
      draw() {
        if (!this.pos) return;
        const px = this.getProjection().fromLatLngToDivPixel(new google.maps.LatLng(this.pos));
        el.style.left = `${px.x}px`; el.style.top = `${px.y - 22}px`;
      }
      moveTo(pos) {
        this.pos = pos; el.classList.remove("hidden"); el.classList.add("moving");
        clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("moving"), 600);
        this.draw();
        if (!map.getBounds()?.contains(pos)) map.panTo(pos);
      }
    }
    const o = new AvatarOverlay(); o.setMap(map); return o;
  }

  function startPinDrop(onDone) {
    if (!map) return;
    const start = userMarker?.getPosition()?.toJSON?.() || map.getCenter()?.toJSON?.() || FALLBACK;
    const marker = new google.maps.Marker({ map, position: start, draggable: true, zIndex: 30, title: "Drag to the storefront",
      icon: { path: PIN_PATH, fillColor: "#38bdf8", fillOpacity: 0.85, strokeColor: "#0b0d12", strokeWeight: 2.5,
        scale: 2, anchor: new google.maps.Point(12, 24), labelOrigin: new google.maps.Point(12, 9) },
      label: { text: "•", color: "#0b0d12", fontSize: "18px", fontWeight: "700" } });
    const panel = $("#pin-drop");
    pinDropActive = true;
    const mapClick = map.addListener("click", (event) => marker.setPosition(event.latLng));
    const finish = (useSpot) => {
      pinDropActive = false;
      google.maps.event.removeListener(mapClick);
      marker.setMap(null);
      panel.classList.add("hidden");
      if (useSpot) onDone(marker.getPosition().toJSON());
    };
    $("#pin-drop-use").onclick = () => finish(true);
    $("#pin-drop-cancel").onclick = () => finish(false);
    panel.classList.remove("hidden");
    map.panTo(start);
  }

  function positionFor(id) {
    if (id.startsWith("pin:")) {
      const pin = typeof nominations !== "undefined" && nominations.pins.find((item) => item.id === id.slice(4));
      return pin ? { lat: pin.lat, lng: pin.lng } : null;
    }
    const plot = plots.find((item) => item.id === id);
    if (!plot) return null;
    const position = plotCentre(plot);
    return position.toJSON?.() ?? position;
  }

  const api = {
    refresh,
    showRoute,
    clearRoute,
    followRoute,
    isFakeLocation: () => fakeLocation,
    avatarToPlot: (id) => { const position = positionFor(id); if (position && avatar) avatar.moveTo(position); },
    avatarToStreet: (id) => { const s = STREETS.find((x) => x.id === id); if (s && avatar) avatar.moveTo(streetStart(s)); },
    avatarHome: () => { if (avatar && anchor) avatar.moveTo(anchor); },
    setFx: (id, kind) => { if (kind) fx.set(id, kind); else fx.delete(id); restyle(id); },
    clearFx: () => { const ids = [...fx.keys()]; fx.clear(); ids.forEach(restyle); },
    focusPlot: (id) => { const position = positionFor(id); if (position && map) map.panTo(position); },
    focus: (position) => { if (map) { map.panTo(position); map.setZoom(Math.max(map.getZoom(), ZOOM)); } },
    onUserMove,
    userPosition,
    toggleFakeLocation,
    plotPosition: positionFor,
    startPinDrop,
  };

  // ---------- Boot ----------
  function initMap() {
    map = new google.maps.Map($("#live-map"), {
      center: FALLBACK, zoom: ZOOM, minZoom: 15, mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
      colorScheme: google.maps.ColorScheme.DARK, styles: DARK_STYLE, gestureHandling: "greedy", clickableIcons: false,
    });
    avatar = makeAvatarOverlay($("#avatar"));
    $("#live-locate").onclick = () => { if (userMarker) { map.panTo(userMarker.getPosition()); map.setZoom(ZOOM); } };
    $("#fake-location").onclick = toggleFakeLocation;
    $("#live-anchor").onclick = anchorHere;
    renderLegend();
    startGeolocation();
  }

  async function boot() {
    let key = "";
    try { key = (await (await fetch("/api/config")).json()).mapsKey; } catch { /* server not reachable; fall through */ }
    if (!key) {
      status("Not configured");
      $("#live-map").innerHTML = `<div class="live-empty">Set <code>GOOGLE_MAPS_API_KEY</code> in <code>.env</code> and restart the server to see the market around you.</div>`;
      return;
    }
    window.__liveMapReady = initMap;
    // Google calls this when the key is rejected (referrer/billing/API not enabled). Otherwise the map just stays black.
    window.gm_authFailure = () => {
      status("Google Maps rejected the API key");
      $("#live-map").insertAdjacentHTML("beforeend", `<div class="live-empty live-error">Google Maps rejected the API key.<br>
        Open the browser console (F12) for the exact error, e.g. <code>RefererNotAllowedMapError</code> (add <code>${location.origin}/*</code> to the key's website restrictions),
        <code>ApiNotActivatedMapError</code> (enable Maps JavaScript API) or <code>BillingNotEnabledMapError</code>.</div>`);
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__liveMapReady`;
    s.async = true;
    s.onerror = () => status("Failed to load Google Maps.");
    document.head.appendChild(s);
  }

  // Google's dark colour scheme does the theming; we only hide clutter so the market reads clearly.
  const DARK_STYLE = [
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
  ];

  return { boot, ...api };
})();

// Called by app.js render() after every state change.
function refreshLiveMap() { LiveMap.refresh(); }

LiveMap.boot();
