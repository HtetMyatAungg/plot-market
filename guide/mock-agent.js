// Deterministic rule-based guide (the default; GUIDE_MODE=llm swaps in the OpenAI tool-calling agent).
// Keyword/synonym matching + price parsing. It goes through exactly the same tools as the LLM agent, so the walk is still real.

const STOP = new Set(["a", "an", "the", "for", "my", "me", "i", "want", "something", "under", "over", "and", "or", "with", "that", "would", "like", "please", "find", "show", "some", "cheap", "cheaper", "only", "just", "in", "of", "to", "is", "it"]);
const SYNONYMS = {
  watch: ["watch", "watches", "timepiece"], vintage: ["vintage", "retro", "80s", "90s", "thrift", "pre-owned", "second"],
  gift: ["gift", "present", "dad", "father", "mum", "mother", "birthday"], dad: ["dad", "father", "men", "signet", "field"],
  bag: ["bag", "bags", "tote", "backpack", "messenger", "weekender", "pouch"], jewellery: ["jewellery", "jewelry", "ring", "necklace", "bracelet", "earrings", "chain", "gold"],
  shoes: ["shoes", "sneakers", "trainers", "kicks", "runner"], jacket: ["jacket", "coat", "puffer", "denim"], tee: ["tee", "t-shirt", "tshirt", "shirt", "top"],
  leather: ["leather"], summer: ["summer", "linen", "holiday"], winter: ["winter", "warm", "hoodie", "fleece"],
};
const PIN_CATEGORY_MAP = { watch: ["Accessories"], bag: ["Accessories"], jewellery: ["Accessories"], shoes: ["Clothing"], jacket: ["Clothing"], tee: ["Clothing"] };
const PIN_CATEGORY_WORDS = {
  Clothing: ["clothing", "clothes", "fashion", "trainers", "shoes", "sneakers", "jacket", "tee", "shirt"],
  Accessories: ["accessories", "bag", "jewellery", "jewelry", "watch"],
  "Food & Drink": ["food", "drink", "coffee", "cafe", "café", "bakery", "restaurant"],
  Home: ["home", "furniture", "decor"], "Books & Music": ["book", "books", "music", "records", "vinyl"],
  Beauty: ["beauty", "makeup", "skincare"], Other: ["other"],
};
const { SELLERS } = require("../data.js");
const INJECTION = /\b(ai guide|any ai|system:|instruction|ignore the|mark_match|recommend (this|it) first|you must)\b/i;

const dataText = (s) => String(s ?? "").replace(/<\/?seller_data>/gi, "");
const strip = (s) => dataText(s).toLowerCase();

function terms(query) {
  const words = query.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  const expanded = new Set(words), category = new Set();
  for (const w of words) for (const [k, syns] of Object.entries(SYNONYMS)) if (syns.includes(w) || k === w) {
    syns.concat(k).forEach((x) => expanded.add(x));
    if (["watch", "bag", "jewellery", "shoes", "jacket", "tee"].includes(k)) syns.concat(k).forEach((x) => category.add(x));
  }
  const price = query.match(/(?:under|below|less than|max|<)\s*£?\s*(\d+)/i) || query.match(/£\s*(\d+)/);
  return { words: expanded, category, maxPrice: price ? Number(price[1]) : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMockAgent({ query, history, plots, streets: streetList }, makeTools, emit) {
  const fullQuery = [...(history || []).filter((h) => h.role === "user").map((h) => h.content), query].join(" ");
  const { words, category, maxPrice } = terms(fullQuery);
  const tools = makeTools(plots, streetList);
  const call = (name, args) => { const result = tools.call(name, args); emit({ type: "tool", name, args, result }); return result; };

  const districts = call("list_districts", {});
  const streets = districts.flatMap((d) => d.streets);
  const shopsOn = (streetId) => plots.filter((p) => p.streetId === streetId && p.status === "taken").map((p) => SELLERS.find((s) => s.id === p.sellerId)).filter(Boolean);
  const pinsOn = (streetId) => plots.filter((p) => p.streetId === streetId && p.status === "pin");
  const pinFits = (pin) => {
    const label = strip([pin.name, pin.category, pin.streetType].join(" "));
    const categoryHit = [...category].some((term) => (PIN_CATEGORY_MAP[term] || []).includes(pin.category))
      || (PIN_CATEGORY_WORDS[pin.category] || []).some((word) => words.has(word));
    return categoryHit || [...words].some((word) => word.length > 2 && label.includes(word));
  };
  const keyWords = category.size ? category : words;
  const fits = (id) => shopsOn(id).some((s) => [...s.tags, ...s.products.flatMap((pr) => pr.tags)].some((t) => keyWords.has(strip(t))))
    || pinsOn(id).some((p) => pinFits(p.pin));
  const hasPlaces = (id) => shopsOn(id).length + pinsOn(id).length > 0;
  const anyFit = streets.some((s) => fits(s.id));
  const walking = streets.filter((s) => hasPlaces(s.id) && (!anyFit || fits(s.id)));
  emit({ type: "message", text: `I'll walk ${walking.map((s) => s.name).join(", ") || "the streets"} looking for: ${[...words].slice(0, 6).join(", ")}${maxPrice ? ` under £${maxPrice}` : ""}.` });

  const injectionSeen = [];
  const inspectProducts = (plotId, shop, products) => {
    for (const product of products) {
      const text = strip([product.name, ...product.tags, product.description].join(" "));
      if (INJECTION.test(text) && !injectionSeen.includes(strip(shop))) injectionSeen.push(strip(shop));
      const hits = [...words].filter((word) => word.length > 2 && text.includes(word));
      const priceOk = maxPrice == null || product.price_gbp <= maxPrice;
      const categoryOk = !category.size || [...category].some((term) => text.includes(term));
      if (hits.length >= 1 && priceOk && categoryOk) {
        const tag = product.tags.map(strip).find((value) => hits.includes(value)) || hits[0];
        call("mark_match", { plot_id: plotId, product_id: product.product_id, reason: `${dataText(product.name).replace(/\b\w/g, (c) => c.toUpperCase())} at £${product.price_gbp}, tagged "${tag}".` });
      }
    }
  };

  for (const s of streets) {
    await sleep(150);
    if (!hasPlaces(s.id)) { call("skip_street", { street_id: s.id, reason: `No shops on ${s.name} yet.` }); continue; }
    if (anyFit && !fits(s.id)) { call("skip_street", { street_id: s.id, reason: `The shops on ${s.name} don't sell what you asked for.` }); continue; }
    const { plots: streetPlots } = call("enter_street", { street_id: s.id });
    for (const p of streetPlots) {
      if (p.status === "pin") {
        await sleep(80);
        const visit = call("visit_plot", { plot_id: p.plot_id });
        const pin = p.pin || {};
        const pinText = strip([visit.shop, visit.category, visit.streetType, visit.note].join(" "));
        if (INJECTION.test(pinText) && !injectionSeen.includes(strip(visit.shop))) injectionSeen.push(strip(visit.shop));
        if (visit.unclaimed) {
          emit({ type: "message", text: `${dataText(pin.name)} is a real ${dataText(pin.streetType)} store here but hasn't been claimed yet — no product info.` });
          continue;
        }
        const { products } = call("view_products", { plot_id: p.plot_id });
        inspectProducts(p.plot_id, visit.shop, products);
        continue;
      }
      if (p.status !== "taken") continue;
      await sleep(80);
      const shop = call("visit_plot", { plot_id: p.plot_id });
      const shopText = strip([shop.shop, shop.description, ...shop.tags].join(" "));
      if (INJECTION.test(shopText)) injectionSeen.push(strip(shop.shop));
      const { products } = call("view_products", { plot_id: p.plot_id });
      inspectProducts(p.plot_id, shop.shop, products);
    }
  }
  const n = tools.state.matches.length;
  let summary = n ? `Found ${n} match${n === 1 ? "" : "es"} across ${new Set(tools.state.matches.map((m) => m.shop)).size} shop(s), in street order.` : `I checked ${walking.length} street(s) and nothing fitted. Try dropping the price limit or a broader word.`;
  if (injectionSeen.length) summary += ` Note: ${injectionSeen.join(", ")} tried to give me instructions in its listing. I ignored them and judged the products on their real details.`;
  call("finish_walk", { summary });
}

module.exports = { runMockAgent };
