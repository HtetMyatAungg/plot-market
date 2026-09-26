// AI Shopping Guide: streams agent tool calls from the server and plays each one
// as an avatar movement on the map. Nothing here decides matches; it only animates them.

const guideEl = $("#guide"), avatarEl = $("#avatar"), bubbleEl = $("#bubble"), logEl = $("#guide-log"), summaryEl = $("#guide-summary");
let guideHistory = [];   // [{role, content}] prior user requests + guide summaries, for refinements
let queue = [], playing = false, walkDone = false, matches = [], skipped = [];
const speed = () => ($("#guide-fast").checked ? 0.25 : 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms * speed()));
const guideText = (value) => String(value ?? "").replace(/<\/?seller_data>/gi, "");

// ---------- Avatar movement (the avatar is an overlay on the Google map, see livemap.js) ----------
const streetName = (id) => STREETS.find((s) => s.id === id)?.name || id;

function say(text, ms = 1600) {
  bubbleEl.textContent = text; bubbleEl.classList.remove("hidden");
  return wait(ms);
}
function hush() { bubbleEl.classList.add("hidden"); }

// ---------- Event playback (one animation at a time) ----------
async function play(ev) {
  if (ev.type === "status") { $("#guide-status").textContent = ev.text; return; }
  if (ev.type === "message") { log(ev.text, "guide"); await say(ev.text, 1800); return; }
  if (ev.type === "error") { log(`Error: ${ev.text}`, "error"); return; }
  if (ev.type !== "tool") return;

  const { name, args, result } = ev;
  if (result?.error) { log(`${name} rejected: ${result.error}`, "reject"); return; }
  switch (name) {
    case "list_districts":
      log("Looking at the map...", "tool");
      LiveMap.avatarHome(); avatarEl.classList.add("idle");
      await wait(500); break;
    case "skip_street":
      skipped.push({ street: streetName(args.street_id), reason: args.reason });
      log(`Skipping ${streetName(args.street_id)}: ${args.reason}`, "skip");
      LiveMap.avatarToStreet(args.street_id);
      await say(`Skipping ${streetName(args.street_id)}`, 900); hush(); break;
    case "enter_street":
      log(`Walking down ${streetName(args.street_id)}`, "tool");
      LiveMap.avatarToStreet(args.street_id);
      await wait(600); break;
    case "visit_plot":
      LiveMap.avatarToPlot(args.plot_id); avatarEl.classList.remove("idle"); avatarEl.classList.add("walking");
      await wait(550); avatarEl.classList.remove("walking");
      await wait(150); break;
    case "view_products":
      LiveMap.setFx(args.plot_id, "peek");
      await wait(500); LiveMap.setFx(args.plot_id, null); break;
    case "mark_match": {
      LiveMap.setFx(args.plot_id, "glow");
      const m = result.match; matches.push(m);
      log(`Match at ${guideText(m.shop)}: ${guideText(m.product)} (£${m.price}) - ${guideText(m.reason)}`, "match");
      await say(`${guideText(m.product)} £${m.price}: ${guideText(m.reason)}`, 2200); hush(); break;
    }
    case "finish_walk":
      walkDone = true;
      LiveMap.avatarHome(); avatarEl.classList.add("idle");
      await say(result.summary, 2500);
      showSummary(result.summary); break;
  }
}

async function drain() {
  if (playing) return; playing = true;
  while (queue.length) await play(queue.shift());
  playing = false;
}

// ---------- Panel ----------
function log(text, kind = "tool") {
  const d = document.createElement("div"); d.className = `log ${kind}`; d.textContent = text;
  logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
}

function showSummary(summary) {
  guideHistory.push({ role: "assistant", content: summary });
  summaryEl.classList.remove("hidden");
  summaryEl.innerHTML = `<h3>Route summary</h3>
    ${matches.length ? `<ol>${matches.map((m) => `<li><button class="link" data-plot="${esc(m.plot_id)}"><b>${esc(guideText(m.shop))}</b> - ${esc(guideText(m.product))} <span class="muted">£${m.price}</span></button><div class="muted small">${esc(guideText(m.reason))}</div></li>`).join("")}</ol>` : `<p class="muted">No matches on this walk.</p>`}
    ${skipped.length ? `<p class="muted small">Skipped: ${skipped.map((s) => `${s.street} (${s.reason})`).join("; ")}</p>` : ""}
    <p class="muted small">Refine below, e.g. "cheaper" or "only thrift".</p>`;
  summaryEl.querySelectorAll("[data-plot]").forEach((b) => (b.onclick = () => {
    LiveMap.focusPlot(b.dataset.plot);
    if (b.dataset.plot.startsWith("pin:")) openPin(b.dataset.plot.slice(4)); else openPlot(b.dataset.plot);
  }));
  $("#guide-input").placeholder = "Refine: cheaper, only thrift, under £30...";
  $("#guide-send").disabled = false;
}

function resetWalkVisuals() {
  LiveMap.clearFx();
  matches = []; skipped = []; walkDone = false; queue = [];
  summaryEl.classList.add("hidden"); hush();
}

async function askGuide(query) {
  resetWalkVisuals();
  log(query, "user");
  guideHistory.push({ role: "user", content: query });
  $("#guide-send").disabled = true;
  if (!STREETS.length) { log("The map hasn't found any streets yet. Wait for it to load.", "error"); $("#guide-send").disabled = false; return; }
  const snapshot = guidePlots();
  const streets = STREETS.map(({ id, name, districtId }) => ({ id, name, districtId }));
  const res = await fetch("/api/guide", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, history: guideHistory.slice(0, -1), plots: snapshot, streets }) });
  if (!res.ok || !res.body) { log(`Server error ${res.status}`, "error"); $("#guide-send").disabled = false; return; }
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (line.startsWith("data: ")) { const ev = JSON.parse(line.slice(6)); if (ev.type === "done") { if (!walkDone) queue.push({ type: "status", text: "" }); } else queue.push(ev); drain(); }
    }
  }
  const finish = setInterval(() => { if (!playing && !queue.length) { clearInterval(finish); $("#guide-send").disabled = false; $("#guide-status").textContent = ""; } }, 200);
}

// ---------- Wire up ----------
$("#ask-guide").onclick = () => { guideEl.classList.remove("hidden"); document.body.classList.add("guide-open"); $("#guide-input").focus(); };
$("#guide-close").onclick = () => { guideEl.classList.add("hidden"); document.body.classList.remove("guide-open"); };
$("#guide-reset").onclick = () => { guideHistory = []; logEl.innerHTML = ""; resetWalkVisuals(); avatarEl.classList.add("hidden"); $("#guide-input").placeholder = "e.g. vintage watch under £50, something my dad would like"; };
$("#guide-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("#guide-input").value.trim(); if (!q || $("#guide-send").disabled) return;
  $("#guide-input").value = ""; askGuide(q);
};
