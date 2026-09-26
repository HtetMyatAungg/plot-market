const dns = require("dns").promises;
const { safeFetch } = require("../import/safe-fetch.js");

function hasMetaToken(html, token) {
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match;
    while ((match = pattern.exec(tag))) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    if (attrs.name?.toLowerCase() === "plot-market-verification" && attrs.content === token) return true;
  }
  return false;
}

function demoDomain(hostname) {
  const domains = String(process.env.DEMO_VERIFIED_DOMAINS || "").split(",").map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function verifyOwnership(website, token) {
  let url;
  try { url = new URL(website); }
  catch { return { ok: false, reason: "Enter a valid website URL." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "Website must use http or https." };
  if (demoDomain(url.hostname)) return { ok: true, method: "demo" };

  let homepageError = "";
  try {
    const homepage = await safeFetch(`${url.origin}/`, { accept: "text/html" });
    if (hasMetaToken(homepage.text, token)) return { ok: true, method: "meta" };
  } catch (error) { homepageError = error.message; }

  try {
    const records = await dns.resolveTxt(url.hostname);
    if (records.some((parts) => parts.join("") === `plot-market-verification=${token}`)) return { ok: true, method: "dns" };
  } catch (error) {
    if (!homepageError && !["ENODATA", "ENOTFOUND", "ENOTIMP", "ENOTSUP"].includes(error.code)) homepageError = error.message;
  }
  if (homepageError) return { ok: false, reason: homepageError };
  return { ok: false, reason: "Token not found in homepage <meta> or DNS TXT" };
}

module.exports = { verifyOwnership, hasMetaToken };
