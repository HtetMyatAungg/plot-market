// SSRF-guarded fetch for seller-supplied URLs (spec A7).
// Only http/https; resolves the hostname and refuses private, loopback, link-local and cloud-metadata ranges;
// follows redirects manually so every hop is re-checked; enforces a timeout and a response size cap.
// Known gap: DNS is resolved before the request (TOCTOU / DNS rebinding); acceptable for the demo.
const dns = require("dns").promises;
const net = require("net");

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "PlotMarket/0.1 (+store import)";
const lastHit = new Map(); // host -> timestamp, crude per-domain politeness

class FetchError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped IPv6
  return mapped ? isPrivateIp(mapped[1]) : false;
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchError("Not a valid URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new FetchError("Only http and https URLs are allowed");
  if (url.username || url.password) throw new FetchError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new FetchError("Local addresses are not allowed");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) throw new FetchError(`Could not resolve ${host}`);
  if (ips.some(isPrivateIp)) throw new FetchError("That address points at a private network");
  return url;
}

async function safeFetch(raw, { accept = "application/json, text/html;q=0.8" } = {}) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const wait = 1000 - (Date.now() - (lastHit.get(url.host) || 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(url.host, Date.now());

    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": USER_AGENT, Accept: accept } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new FetchError("Redirect without location", 502);
      url = await assertPublicUrl(new URL(loc, url).href);
      continue;
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new FetchError("Response too large", 502);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new FetchError("Response too large", 502);
    return { status: res.status, ok: res.ok, headers: res.headers, text: buf.toString("utf8"), url: url.href };
  }
  throw new FetchError("Too many redirects", 502);
}

module.exports = { safeFetch, assertPublicUrl, isPrivateIp, FetchError };
