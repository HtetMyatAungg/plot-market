# Plot Market

Shopping plots on the real streets around you, drawn on a live Google map. Sellers rent a plot for £10/month; shoppers browse by walking the streets, or ask a guide to walk for them.

## Run

```bash
cd plot-market
cp .env.example .env     # add GOOGLE_MAPS_API_KEY (required for the map).
                         # the guide is rule-based by default; set GUIDE_MODE=llm + OPENAI_API_KEY to use the OpenAI agent.
node server.js           # http://localhost:8765
```

No dependencies. Node 18+ (uses built-in `fetch`).

## The map

The streets are real roads. On load the browser geolocates you, the server fetches named roads within 500 m
from OpenStreetMap (`/api/roads`, Overpass API, cached 10 min, no key needed) and joins split OSM ways into one
path per road. The client selects nearby roads in four bearing quadrants (North, East, South and West), up to 4
per quarter and 16 total. Streets support up to 12 houses (6 per side); shorter roads with at least 4 stations
still qualify and receive 8 or 10 plots. A full grid has 192 plots, seeded with 144 rented shops and 4 auctions.
Districts are drawn as a hull around their plots. If road data is unavailable a plain grid is used instead.
Plots are clickable (rent / bid modal). "Move plots here" re-lays the market on the roads around your current
position (resets the demo tenancies). The guide's avatar walks the map as a Google Maps overlay and matched
plots glow. Needs `GOOGLE_MAPS_API_KEY` (Maps JavaScript API, browser key restricted by HTTP referrer).
Geolocation requires `localhost` or HTTPS.

## Files

- `index.html`, `style.css` - UI shell (full-screen map with floating HUD panels)
- `data.js` - four districts, 32 demo shops with tagged products, seeded 75% tenancies and four auction seeds (shared by browser and server)
- `app.js` - rent / 1-per-street / expiry / auction logic, plot modal, "skip 1 month" demo button; `initMarket(streets)` seeds plots once roads are known
- `livemap.js` - Google Maps view: geolocation, road selection + plot layout along roads, district hulls, avatar overlay, legend
- `guide.js` - AI guide frontend: SSE client, event queue, avatar, bubbles, glow, route summary
- `server.js` - static server, `/api/roads` (OpenStreetMap proxy), `/api/guide` (rule-based guide, or OpenAI tool-calling agent when `GUIDE_MODE=llm`; any OpenAI-compatible endpoint via `LLM_BASE_URL`)
- `guide/mock-agent.js` - rule-based guide (default): keyword/synonym matching, price parsing, same tools as the LLM
- `import/safe-fetch.js` - SSRF-guarded fetch for seller URLs (http/https only, private/loopback/link-local IPs blocked after DNS, manual redirects, 10 s timeout, 5 MB cap, 1 req/s per host)
- `import/shopify.js` - import route 1: detects `/products.json`, pages through it, normalises to the shared product shape (title, price, currency, availability, image, link, variants, description, tags, source, lastSynced); capped at 200 products
- `import/catalogue.js` - published catalogues per seller, persisted to `data/catalogues.json`; `productsFor(seller)` falls back to demo products

## Importing a real store (Shopify for now)

Open a plot you own -> "Import your store" -> paste a Shopify URL (e.g. `https://www.allbirds.co.uk`) -> Preview.
Untick anything you don't want shown (out-of-stock items start unticked) -> Publish. The shop modal then shows the
real products with images, prices and "updated X ago"; the guide's `view_products` reads the same catalogue and
never offers out-of-stock items. Publish re-uses the server's fetched preview, so the browser can't inject products.

API: `POST /api/import/preview {url}`, `POST /api/import/publish {url, sellerId, hidden:[ids]}`,
`POST /api/import/unpublish {sellerId}`, `GET /api/catalogues`.

## Store nominations

Shoppers can nominate public storefronts from the map. Approved nominations appear as real-store pins and reserve their nearby plot. Admins review nominations at `/admin.html` (not linked from the shopper UI). Set `ADMIN_TOKEN` in `.env` to require the same token in the admin page; without it, the demo admin page is open.

## Claiming a store

A seller selects their identity in the demo and starts a claim on an approved pin. Add the displayed `<meta name="plot-market-verification" content="TOKEN">` tag to the claimed storefront's homepage, or publish `plot-market-verification=TOKEN` as a DNS TXT record, then choose **Check now**. `DEMO_VERIFIED_DOMAINS` is a comma-separated development allow-list for automatic verification; leave it unset for real checks. If the claimant has no website, an admin can approve the request at `/admin.html`.

An active claim includes £10/month demo rent, an optional 80-character in-person deal, and a Shopify catalogue stored under `pin:<nomination-id>`. If rent lapses, the pin becomes unclaimed, its deal and catalogue are removed, and it is never offered for rent. The guide visits pins in street order; it gives unclaimed pins a short notice without inventing product details and can search a claimed pin's published products.

## Walking routes

Plot and store modals can request a foot route through `/api/route`; the server uses OSRM's foot router with the public OSRM router as fallback and caches successful routes for 10 minutes. These public routers ask for light use, so avoid high-volume polling. If both are unavailable, the client displays a direct-line estimate. **Walk there** follows the route only in Fake my location mode; the guide can also build a multi-stop route through its matches.

## GO mechanic

When a shopper comes within 30 m of a claimed store with an in-person deal, a proximity card offers **Unlock deal**. The server independently checks a 60 m radius for GPS tolerance and issues one reusable `PM-XXXX-XXXX` code per shopper and pin to show at the till; the codes map is never returned to clients. Use **Fake my location** to drag the shopper marker or tap a map destination and simulate a straight-line walk (about 1.4 m/s, capped at 3 seconds) without real GPS.

Not built yet: daily catalogue sync + "refresh now", WooCommerce, JSON-LD, and LLM extraction / tag generation. Anyone can currently import any Shopify store, so treat this as demo-only.

## The guide is a real walk

Every agent tool call is streamed to the browser and played as one avatar move:
`list_districts` -> `enter_street` / `skip_street` -> `visit_plot` -> `view_products` -> `mark_match` -> `finish_walk`.

Server-side guardrails, independent of the model:
- `visit_plot` requires `enter_street` first and enforces position order
- `mark_match` rejects any product id not returned by `view_products` for that plot
- all seller text is wrapped in `<seller_data>` and the system prompt treats it as untrusted
- max 400 tool calls per walk

`Trust Me Watches` remains the prompt-injection test shop; its seeded plot may vary by map street.

## Demo script

1. Rent a plot, switch seller, show the 1-per-street block, hit "Skip 1 month".
2. "Ask the Guide": *vintage watch under £50, something my dad would like*.
3. Watch it skip the streets whose shops have no watches and say why.
4. Route summary lists every match in visit order.
5. Open Trust Me Watches: "this seller tried to hijack the guide. It didn't work."
6. Refine: *only thrift* or *cheaper*.
