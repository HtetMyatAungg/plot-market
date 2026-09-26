const adminList = document.querySelector("#admin-list");
const adminMessage = document.querySelector("#admin-message");
const tokenInput = document.querySelector("#admin-token");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

try { tokenInput.value = sessionStorage.getItem("pm-admin-token") || ""; } catch { /* session storage can be unavailable in private mode */ }

function headers() {
  const result = {};
  if (tokenInput.value) result["x-admin-token"] = tokenInput.value;
  return result;
}

function setMessage(text, isError = false) {
  adminMessage.textContent = text;
  adminMessage.classList.toggle("error", isError);
}

function flagLabel(flag, names) {
  const [type, id] = flag.split(":");
  const name = names.get(id) || id;
  return type === "likely_duplicate" ? `Likely duplicate of ${name}` : `Same photo as ${name}`;
}

function render(records) {
  const names = new Map(records.map((record) => [record.id, record.name]));
  const ordered = [...records].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt));
  if (!ordered.length) { adminList.innerHTML = `<p class="admin-empty">No nominations yet.</p>`; return; }
  adminList.innerHTML = ordered.map((record) => {
    const status = ["pending", "approved", "claimed", "rejected", "removed"].includes(record.status) ? record.status : "removed";
    const claimStatus = record.claim?.status;
    const claimSeller = SELLERS.find((seller) => seller.id === record.claim?.sellerId)?.name || record.claim?.sellerId;
    const claimLabel = claimStatus === "active" ? `Claim: active (${claimSeller})` : claimStatus ? `Claim: ${claimStatus.replace(/_/g, " ")}` : "";
    const photoUrl = `/api/nominations/${encodeURIComponent(record.id)}/photo`;
    const flags = (record.flags || []).map((flag) => `<span class="admin-flag">${esc(flagLabel(flag, names))}</span>`).join("");
    const website = record.website ? `<a href="${esc(record.website)}" target="_blank" rel="noopener">${esc(record.website)}</a>` : "—";
    const nominator = String(record.nominatorId || "");
    return `<article class="admin-card ${status}" data-id="${esc(record.id)}">
      <header class="admin-card-head"><div><h2>${esc(record.name)}</h2><span class="muted small">${esc(record.category)} · ${esc(record.streetType)}</span></div><div class="admin-statuses"><span class="status-chip ${status}">${esc(status)}</span>${claimLabel ? `<span class="status-chip claim-chip ${esc(claimStatus)}">${esc(claimLabel)}</span>` : ""}</div></header>
      <div class="admin-card-body">
        <img class="admin-photo" src="${esc(photoUrl)}" alt="Storefront photo" loading="lazy">
        <div class="admin-details">
          <p><b>Note:</b> ${record.note ? esc(record.note) : "—"}</p>
          <p><b>Website:</b> ${website}</p>
          <p><b>Location:</b> ${Number(record.lat).toFixed(5)}, ${Number(record.lng).toFixed(5)}</p>
          <p title="${esc(nominator)}"><b>Nominator:</b> ${esc(nominator.length > 16 ? `${nominator.slice(0, 13)}…` : nominator)}</p>
          <p><b>Nominated:</b> ${esc(new Date(record.createdAt).toLocaleString())}</p>
          ${record.rejectReason ? `<p class="warn"><b>Rejection reason:</b> ${esc(record.rejectReason)}</p>` : ""}
          ${flags ? `<div class="admin-flags">${flags}</div>` : ""}
        </div>
      </div>
      ${status === "pending" ? `<div class="admin-actions"><button class="btn small" data-action="approve">Approve</button><button class="btn ghost small" data-action="reject">Reject</button></div>
        <div class="admin-reject-row"><input class="reject-reason" type="text" maxlength="240" required placeholder="Reason required to reject" aria-label="Rejection reason"><button class="btn small" data-action="confirm-reject">Confirm rejection</button></div>` : ""}
      ${status === "approved" ? `<div class="admin-actions"><button class="btn ghost small" data-action="remove">Remove</button></div>` : ""}
      ${["pending_admin", "pending_verification"].includes(claimStatus) ? `<div class="admin-actions claim-actions"><button class="btn small" data-action="approve-claim">Approve claim</button><button class="btn ghost small" data-action="reject-claim">Reject claim</button></div>` : ""}
    </article>`;
  }).join("");
}

async function load() {
  setMessage("Loading nominations…");
  try {
    const response = await fetch("/api/admin/nominations", { headers: headers() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    render(data);
    setMessage(`${data.length} nomination${data.length === 1 ? "" : "s"} · refreshed ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function decide(id, status, reason = "") {
  try {
    const response = await fetch(`/api/admin/nominations/${encodeURIComponent(id)}/decide`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers() }, body: JSON.stringify({ status, reason }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    await load();
  } catch (error) { setMessage(error.message, true); }
}

async function decideClaim(id, status) {
  try {
    const response = await fetch(`/api/admin/nominations/${encodeURIComponent(id)}/claim/decide`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers() }, body: JSON.stringify({ status }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    await load();
  } catch (error) { setMessage(error.message, true); }
}

document.querySelector("#admin-token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try { sessionStorage.setItem("pm-admin-token", tokenInput.value); } catch { /* session storage can be unavailable in private mode */ }
  load();
});
tokenInput.addEventListener("change", () => {
  try { sessionStorage.setItem("pm-admin-token", tokenInput.value); } catch { /* session storage can be unavailable in private mode */ }
});
adminList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest(".admin-card"), id = card.dataset.id;
  if (button.dataset.action === "approve") decide(id, "approved");
  if (button.dataset.action === "remove") decide(id, "removed");
  if (button.dataset.action === "approve-claim") decideClaim(id, "approved");
  if (button.dataset.action === "reject-claim") decideClaim(id, "rejected");
  if (button.dataset.action === "reject") {
    const row = card.querySelector(".admin-reject-row");
    row.classList.add("open");
    row.querySelector(".reject-reason").focus();
  }
  if (button.dataset.action === "confirm-reject") {
    const input = card.querySelector(".reject-reason");
    if (!input.value.trim()) { setMessage("A reason is required to reject a nomination.", true); input.focus(); return; }
    decide(id, "rejected", input.value.trim());
  }
});

load();
setInterval(load, 10_000);
