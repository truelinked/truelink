#!/usr/bin/env node
"use strict";

const axios   = require("axios");
const cheerio = require("cheerio");
const natural = require("natural");
const chalk   = require("chalk");
const { removeStopwords, eng } = require("stopword");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const LIVE_URL = process.argv[2] || null;
const TEST_URL = process.argv[3] || null;
const TOP_N    = 40;

if (!LIVE_URL) {
  console.error(chalk.red("\nUsage: node index.js <live-url> [test-url]\n"));
  process.exit(1);
}

// ─── Markdown buffer ──────────────────────────────────────────────────────────
const _md = [];
function md(line) { _md.push(line ?? ""); }
function saveMd() {
  const now   = new Date();
  const pad   = n => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
              + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const file  = path.join(process.cwd(), `truelink_${stamp}.md`);
  fs.writeFileSync(file, _md.join("\n") + "\n", "utf8");
  console.log(chalk.cyan(`\n  📄 Report saved → ${file}`));
}

// ─── NLP setup ────────────────────────────────────────────────────────────────
const tokenizer  = new natural.WordTokenizer();
const stemmer    = natural.PorterStemmer;
const TfIdf      = natural.TfIdf;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── JS / UI noise blacklist ──────────────────────────────────────────────────
const NOISE = new Set([
  "undefined","null","false","true","nan","infinity",
  "const","let","var","function","return","class","extends","import","export",
  "async","await","promise","resolve","reject","throw","catch","try","new",
  "typeof","instanceof","void","delete","yield","static","default","super",
  "react","next","webpack","chunks","chunk","module","require","props","state",
  "children","render","handler","callback","usestate","useeffect","usememo",
  "hydrat","nextdata","pageprop","buildid","selfnext",
  "div","span","nav","aside","footer","header","main","section","article",
  "button","input","form","label","select","option","textarea",
  "classname","dataset","aria","tabindex","viewport","charset","utf",
  "href","src","rel","alt","type","name","value","placeholder",
  "push","pop","map","filter","reduce","foreach","find","some","every","slice",
  "splice","concat","join","split","replace","trim","length","keys","values",
  "entries","object","array","string","number","boolean","json","parse",
  "stringify","math","date","window","document","navigator","location",
  "history","console","log","error","warn","fetch","then",
  "get","set","put","del","add","use","run","end","top","new","old","all",
  "one","two","ago","via","per","non","pro","sub","pre","post","out","off",
]);

// ─── Fetch page ───────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    httpsAgent,
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SEO-Analyzer/2.0)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return { html: res.data, finalUrl: res.request.res.responseUrl || url };
}

// ─── Space-aware text extractor (fixes nav concatenation) ────────────────────
const BLOCK = new Set(["p","li","td","th","dt","dd","h1","h2","h3","h4","h5","h6",
                       "div","section","article","blockquote","figcaption",
                       "a","span","strong","em","b","i","label","button"]);

function extractSpacedText($, selector) {
  const parts = [];
  $(selector).find("*").addBack().each((_, el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (BLOCK.has(tag)) {
      const own = $(el).clone().children().remove().end().text().trim();
      if (own) parts.push(own);
    }
  });
  return parts.join(" ");
}

// ─── Rich-result rules ────────────────────────────────────────────────────────
// Required / recommended properties that drive Google rich-result eligibility.
// (Pragmatic subset of schema.org + Google's structured-data docs.)
const RICH_RESULT_RULES = {
  Article:         { required: ["headline"], recommended: ["image", "datePublished", "dateModified", "author"] },
  NewsArticle:     { required: ["headline"], recommended: ["image", "datePublished", "dateModified", "author"] },
  BlogPosting:     { required: ["headline"], recommended: ["image", "datePublished", "dateModified", "author"] },
  Product:         { required: ["name"], recommended: ["image", "description", "offers", "aggregateRating", "review", "brand", "sku"] },
  Offer:           { required: ["price", "priceCurrency"], recommended: ["availability", "url", "priceValidUntil"] },
  AggregateOffer:  { required: ["lowPrice", "priceCurrency"], recommended: ["highPrice", "offerCount"] },
  BreadcrumbList:  { required: ["itemListElement"], recommended: [] },
  FAQPage:         { required: ["mainEntity"], recommended: [] },
  QAPage:          { required: ["mainEntity"], recommended: [] },
  Question:        { required: ["name", "acceptedAnswer"], recommended: ["answerCount"] },
  HowTo:           { required: ["name", "step"], recommended: ["image", "totalTime", "tool", "supply"] },
  Recipe:          { required: ["name", "recipeIngredient", "recipeInstructions"], recommended: ["image", "author", "datePublished", "nutrition", "aggregateRating", "totalTime"] },
  Event:           { required: ["name", "startDate", "location"], recommended: ["endDate", "image", "offers", "performer", "eventStatus"] },
  Organization:    { required: ["name"], recommended: ["url", "logo", "sameAs", "contactPoint"] },
  LocalBusiness:   { required: ["name", "address"], recommended: ["telephone", "openingHours", "geo", "priceRange", "image"] },
  Person:          { required: ["name"], recommended: ["url", "sameAs"] },
  WebSite:         { required: ["name", "url"], recommended: ["potentialAction"] },
  WebPage:         { required: [], recommended: ["name", "description"] },
  VideoObject:     { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration", "contentUrl", "embedUrl"] },
  ImageObject:     { required: [], recommended: ["url", "width", "height"] },
  Review:          { required: ["reviewRating", "author"], recommended: ["itemReviewed", "datePublished"] },
  AggregateRating: { required: ["ratingValue"], recommended: ["reviewCount", "ratingCount", "bestRating"] },
  JobPosting:      { required: ["title", "description", "datePosted", "hiringOrganization", "jobLocation"], recommended: ["validThrough", "baseSalary", "employmentType"] },
};

const ARTICLE_ALIASES = { Article: "Article", NewsArticle: "Article", BlogPosting: "Article" };

// ─── Schema.org extractor ─────────────────────────────────────────────────────
// Walks every JSON-LD block recursively so @graph arrays, top-level arrays, and
// nested entities (author, publisher, …) are all captured — not just the root
// @type. Validates detected entities against rich-result rules. Microdata/RDFa
// is picked up as a fallback.
function extractSchema($) {
  const nodes      = [];   // every object that carries an @type
  const counts     = {};   // type → occurrence count
  let   blocks     = 0;    // ld+json scripts found
  let   parseErr   = 0;    // ld+json scripts that failed to parse
  let   ctxMissing = 0;    // ld+json scripts with no @context

  const typesOf = node => {
    const t = node["@type"];
    return t ? (Array.isArray(t) ? t : [t]).map(String) : [];
  };

  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const ts = typesOf(node);
    if (ts.length) { nodes.push(node); ts.forEach(t => counts[t] = (counts[t] || 0) + 1); }
    for (const [key, val] of Object.entries(node)) {
      if (key === "@type") continue;
      if (val && typeof val === "object") visit(val);
    }
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    blocks++;
    const raw = ($(el).contents().text() || $(el).html() || "")
      .replace(/[\u0000-\u001F]/g, "");
    if (!raw.trim()) return;
    try {
      const data = JSON.parse(raw);
      const hasCtx = JSON.stringify(data).includes("schema.org");
      if (!hasCtx) ctxMissing++;
      visit(data);
    } catch { parseErr++; }
  });

  // Microdata + RDFa fallback (Google still consumes these).
  $("[itemscope][itemtype], [typeof]").each((_, el) => {
    const attr = $(el).attr("itemtype") || $(el).attr("typeof") || "";
    attr.split(/\s+/).filter(Boolean).forEach(u => {
      const name = u.split(/[\/#:]/).filter(Boolean).pop();
      if (name) counts[name] = (counts[name] || 0) + 1;
    });
  });

  return {
    types       : Object.keys(counts).sort((a, b) => a.localeCompare(b)),
    counts,
    validation  : validateSchema(nodes),
    jsonLdBlocks: blocks,
    parseErrors : parseErr,
    ctxMissing,
  };
}

// ─── Rich-result validation ───────────────────────────────────────────────────
// Aggregates missing required/recommended props per type across all instances.
function validateSchema(nodes) {
  const has = (node, p) => {
    const v = node[p];
    return v !== undefined && v !== null && v !== "" &&
           !(Array.isArray(v) && v.length === 0);
  };
  const byType = {};
  for (const node of nodes) {
    const ts = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    for (const type of ts.map(String)) {
      const rule = RICH_RESULT_RULES[type];
      if (!rule) continue;
      const b = byType[type] || (byType[type] = { count: 0, missingRequired: {}, missingRecommended: {} });
      b.count++;
      rule.required.forEach(p => { if (!has(node, p)) b.missingRequired[p] = (b.missingRequired[p] || 0) + 1; });
      rule.recommended.forEach(p => { if (!has(node, p)) b.missingRecommended[p] = (b.missingRecommended[p] || 0) + 1; });
    }
  }
  return byType;
}

// ─── Social meta ──────────────────────────────────────────────────────────────
function extractSocialMeta($) {
  return {
    ogTitle       : $('meta[property="og:title"]').attr("content") || "",
    ogDescription : $('meta[property="og:description"]').attr("content") || "",
    ogImage       : $('meta[property="og:image"]').attr("content") || "",
    ogType        : $('meta[property="og:type"]').attr("content") || "",
    twitterCard   : $('meta[name="twitter:card"]').attr("content") || "",
    twitterTitle  : $('meta[name="twitter:title"]').attr("content") || "",
  };
}

// ─── Link analysis ────────────────────────────────────────────────────────────
function extractLinks($, baseUrl) {
  const base   = new URL(baseUrl);
  const intern = [], extern = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname === base.hostname) intern.push({ href: abs.pathname, text });
      else extern.push({ href: abs.href, text });
    } catch {}
  });
  return { internal: intern, external: extern };
}

// ─── Text cleaning pipeline ───────────────────────────────────────────────────
function cleanText(raw) {
  return raw
    .replace(/\\u[0-9a-fA-F]{4}/gi, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[|\\/<>{}[\]()=+*^$#@~`]/g, " ")
    .replace(/["'';:!?.,]/g, " ")
    .replace(/\b\d[\d.,\-_%/]*\b/g, " ")
    .replace(/\b[a-z]+[A-Z]\w+\b/g, " ")
    .replace(/\b[A-Z]{2,}\b/g, w => w.toLowerCase())
    .replace(/\b\w{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Full signal extraction ───────────────────────────────────────────────────
function extractSignals($, url) {
  const schema      = extractSchema($);
  const socialMeta  = extractSocialMeta($);
  const links       = extractLinks($, url);

  $("script, style, noscript, iframe, svg, canvas, template, " +
    "[aria-hidden='true'], [class*='hidden'], [id*='hidden'], " +
    "[class*='sr-only'], [class*='visually-hidden']").remove();

  const rawBody     = extractSpacedText($, "body");
  const bodyText    = cleanText(rawBody);
  const headingText = cleanText([
    ...$("h1").map((_, el) => $(el).text().trim()).get(),
    ...$("h2").map((_, el) => $(el).text().trim()).get(),
    ...$("h3").map((_, el) => $(el).text().trim()).get(),
  ].join(" "));
  const altText = cleanText(
    $("img[alt]").map((_, el) => $(el).attr("alt").trim()).get().filter(Boolean).join(" ")
  );

  return {
    title       : $("title").first().text().trim(),
    description : $('meta[name="description"]').attr("content") || "",
    keywords    : $('meta[name="keywords"]').attr("content") || "",
    canonical   : $('link[rel="canonical"]').attr("href") || "",
    robots      : $('meta[name="robots"]').attr("content") || "",
    hreflang    : $('link[rel="alternate"][hreflang]').map((_, el) => $(el).attr("hreflang")).get().join(", "),
    h1          : $("h1").map((_, el) => $(el).text().trim()).get(),
    h2          : $("h2").map((_, el) => $(el).text().trim()).get(),
    h3          : $("h3").map((_, el) => $(el).text().trim()).get(),
    imgAlts     : $("img[alt]").map((_, el) => $(el).attr("alt").trim()).get().filter(Boolean),
    wordCount   : bodyText.split(/\s+/).filter(Boolean).length,
    schemaTypes : schema.types,
    schema,
    socialMeta, links,
    bodyText, headingText, altText,
  };
}

// ─── Keyword scoring ──────────────────────────────────────────────────────────
function scoreKeywords(signals, topN = TOP_N) {
  const tfidf = new TfIdf();

  function tokenize(text, weight = 1) {
    const tokens = removeStopwords(
      tokenizer.tokenize(text.toLowerCase()), eng
    ).filter(t => t.length > 2 && !NOISE.has(t) && !/^\d+$/.test(t));
    const weighted = [];
    for (let i = 0; i < weight; i++) weighted.push(...tokens);
    return weighted;
  }

  const bodyTokens    = tokenize(signals.bodyText,    1);
  const headingTokens = tokenize(signals.headingText, 4);
  const altTokens     = tokenize(signals.altText,     2);
  const titleTokens   = tokenize(signals.title,       5);
  const descTokens    = tokenize(signals.description, 3);
  const allTokens     = [...bodyTokens, ...headingTokens, ...altTokens, ...titleTokens, ...descTokens];

  const freq = {};
  allTokens.forEach(t => freq[t] = (freq[t] || 0) + 1);

  tfidf.addDocument(allTokens.join(" "));

  const bigrams = bodyTokens
    .filter((_, i) => i < bodyTokens.length - 1)
    .map((t, i) => `${t} ${bodyTokens[i + 1]}`);
  const bigramFreq = {};
  bigrams.forEach(b => bigramFreq[b] = (bigramFreq[b] || 0) + 1);

  const scores = {};
  tfidf.listTerms(0).forEach(({ term, tfidf: score }) => {
    if (NOISE.has(term)) return;
    scores[term] = score * Math.log(1 + (freq[term] || 1));
  });
  Object.entries(bigramFreq).forEach(([bg, f]) => {
    if (f >= 2) scores[bg] = (scores[bg] || 0) + f * 1.5;
  });

  // Stem dedup
  const stemMap = {};
  Object.entries(scores).forEach(([kw, score]) => {
    if (kw.includes(" ")) { stemMap[kw] = { kw, score }; return; }
    const stem = stemmer.stem(kw);
    if (!stemMap[stem] || stemMap[stem].score < score) stemMap[stem] = { kw, score };
  });

  return Object.values(stemMap)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ kw, score }) => ({ kw, score: +score.toFixed(2) }));
}

// ─── SEO audit ────────────────────────────────────────────────────────────────
function seoAudit(signals) {
  const issues = [], warns = [], passes = [];
  const t = signals.title, d = signals.description;

  if (!t)                   issues.push("Missing <title> tag");
  else if (t.length < 30)   warns.push(`Title too short (${t.length} chars, aim 50-60)`);
  else if (t.length > 60)   warns.push(`Title too long (${t.length} chars, aim 50-60)`);
  else                      passes.push(`Title length OK (${t.length} chars)`);

  if (!d)                   issues.push("Missing meta description");
  else if (d.length < 70)   warns.push(`Description too short (${d.length} chars, aim 120-160)`);
  else if (d.length > 160)  warns.push(`Description too long (${d.length} chars, aim 120-160)`);
  else                      passes.push(`Meta description length OK (${d.length} chars)`);

  if (signals.h1.length === 0)    issues.push("No H1 tag found");
  else if (signals.h1.length > 1) warns.push(`Multiple H1 tags (${signals.h1.length}) — use only one`);
  else                            passes.push("Single H1 present");

  if (!signals.canonical) warns.push("No canonical tag"); else passes.push("Canonical tag present");

  if (signals.robots.includes("noindex"))  issues.push("noindex is set — page will NOT be indexed");
  if (signals.robots.includes("nofollow")) warns.push("nofollow set — links won't be followed");

  if (signals.imgAlts.length === 0) warns.push("No images with alt text found");
  else passes.push(`${signals.imgAlts.length} images have alt text`);

  const schema = signals.schema || { types: [], counts: {}, validation: {}, jsonLdBlocks: 0, parseErrors: 0, ctxMissing: 0 };
  if (schema.types.length === 0) warns.push("No Schema.org structured data found");
  else passes.push(`Schema.org (${schema.types.length} types): ${schema.types.join(", ")}`);
  if (schema.parseErrors)
    issues.push(`${schema.parseErrors} JSON-LD block(s) failed to parse — invalid structured data`);
  if (schema.ctxMissing)
    warns.push(`${schema.ctxMissing} JSON-LD block(s) missing schema.org @context`);

  Object.entries(schema.validation).forEach(([type, v]) => {
    const req = Object.entries(v.missingRequired);
    const rec = Object.entries(v.missingRecommended);
    if (req.length)
      issues.push(`${type}: missing required ${req.map(([p, n]) => v.count > 1 ? `${p} (${n}/${v.count})` : p).join(", ")} — not eligible for rich results`);
    else if (rec.length)
      warns.push(`${type}: missing recommended ${rec.map(([p]) => p).join(", ")}`);
    else
      passes.push(`${type} structured data valid for rich results`);
  });

  if (!signals.socialMeta.ogTitle)       warns.push("No og:title tag");
  else                                   passes.push("og:title present");
  if (!signals.socialMeta.ogDescription) warns.push("No og:description tag");
  if (!signals.socialMeta.ogImage)       warns.push("No og:image tag");
  else                                   passes.push("og:image present");
  if (!signals.socialMeta.twitterCard)   warns.push("No twitter:card tag");
  else                                   passes.push("twitter:card present");

  if (signals.hreflang) passes.push(`hreflang: ${signals.hreflang}`);

  if (signals.wordCount < 100)  warns.push(`Low word count: ${signals.wordCount} (aim 300+)`);
  else                          passes.push(`Word count: ${signals.wordCount}`);

  const iLinks = signals.links.internal.length;
  if (iLinks === 0) warns.push("No internal links found");
  else passes.push(`${iLinks} internal links`);

  const seoScore = Math.round(
    100 * passes.length / (passes.length + warns.length * 0.5 + issues.length * 1)
  );

  return { issues, warns, passes, seoScore };
}

// ─── Print + write report ─────────────────────────────────────────────────────
function printReport(label, url, signals, keywords, audit) {
  const BG = label === "LIVE" ? chalk.bgBlue : chalk.bgMagenta;
  console.log("\n" + BG.white.bold(` ── ${label} ── `) + " " + chalk.gray(url));

  // MD section header
  md(`\n---\n`);
  md(`## ${label} — ${url}\n`);

  // ── Meta
  const logField = (name, val, warn) => {
    const w = warn ? chalk.yellow(" ⚠") : "";
    console.log(chalk.cyan(`  ${name.padEnd(16)}`), (val || chalk.gray("(empty)")) + w);
  };
  const mdField = (name, val, warn) => {
    const icon = warn ? "⚠️" : "✅";
    md(`| ${icon} | **${name}** | ${val || "_(empty)_"} |`);
  };

  console.log(chalk.cyan("\n  ── Meta ──────────────────────────────────"));
  md("\n### Meta\n");
  md("| | Field | Value |");
  md("|---|---|---|");

  const titleWarn = !signals.title || signals.title.length < 30 || signals.title.length > 60;
  const descWarn  = !signals.description || signals.description.length < 70 || signals.description.length > 160;

  const sm = signals.schema || { types: [], counts: {}, validation: {}, jsonLdBlocks: 0, parseErrors: 0, ctxMissing: 0 };
  const schemaSummary = sm.types.length
    ? `${sm.types.map(t => sm.counts[t] > 1 ? `${t}×${sm.counts[t]}` : t).join(", ")}`
      + `  (${sm.types.length} types, ${sm.jsonLdBlocks} JSON-LD block${sm.jsonLdBlocks === 1 ? "" : "s"}`
      + (sm.parseErrors ? `, ${sm.parseErrors} invalid` : "") + ")"
    : "none";

  logField("Title",          signals.title, titleWarn);
  logField("Description",    signals.description.slice(0, 110) + (signals.description.length > 110 ? "…" : ""), descWarn);
  logField("Canonical",      signals.canonical || "(none)", !signals.canonical);
  logField("Robots",         signals.robots || "(default: index,follow)");
  logField("hreflang",       signals.hreflang || "none");
  logField("Keywords meta",  signals.keywords || "none");
  logField("Schema",         schemaSummary, !signals.schemaTypes.length || !!sm.parseErrors);
  logField("og:title",       signals.socialMeta.ogTitle || "none", !signals.socialMeta.ogTitle);
  logField("og:type",        signals.socialMeta.ogType || "none");
  logField("og:image",       signals.socialMeta.ogImage ? "✔ present" : "none", !signals.socialMeta.ogImage);
  logField("twitter:card",   signals.socialMeta.twitterCard || "none");
  logField("Word count",     String(signals.wordCount), signals.wordCount < 100);
  logField("Internal links", String(signals.links.internal.length));
  logField("External links", String(signals.links.external.length));

  mdField("Title",          signals.title, titleWarn);
  mdField("Description",    signals.description.slice(0, 160) || "(empty)", descWarn);
  mdField("Canonical",      signals.canonical || "(none)", !signals.canonical);
  mdField("Robots",         signals.robots || "(default: index,follow)");
  mdField("hreflang",       signals.hreflang || "none");
  mdField("Schema",         schemaSummary, !signals.schemaTypes.length || !!sm.parseErrors);
  mdField("og:title",       signals.socialMeta.ogTitle || "none", !signals.socialMeta.ogTitle);
  mdField("og:image",       signals.socialMeta.ogImage ? "✔ present" : "none", !signals.socialMeta.ogImage);
  mdField("twitter:card",   signals.socialMeta.twitterCard || "none", !signals.socialMeta.twitterCard);
  mdField("Word count",     String(signals.wordCount), signals.wordCount < 100);
  mdField("Internal links", String(signals.links.internal.length));
  mdField("External links", String(signals.links.external.length));

  // ── Structured Data
  console.log(chalk.cyan("\n  ── Structured Data ───────────────────────"));
  md("\n### Structured Data\n");
  if (!sm.types.length) {
    console.log(chalk.yellow("    ⚠ No Schema.org structured data found"));
    md("⚠️ No Schema.org structured data found");
  } else {
    console.log(chalk.gray(`    ${sm.jsonLdBlocks} JSON-LD block(s)`)
      + (sm.parseErrors ? chalk.red(`, ${sm.parseErrors} invalid`) : "")
      + (sm.ctxMissing ? chalk.yellow(`, ${sm.ctxMissing} without @context`) : ""));
    md(`_${sm.jsonLdBlocks} JSON-LD block(s)`
      + (sm.parseErrors ? `, ${sm.parseErrors} invalid` : "")
      + (sm.ctxMissing ? `, ${sm.ctxMissing} without @context` : "") + `_\n`);
    md("| Type | Count | Rich-result status |");
    md("|---|---:|---|");
    sm.types.forEach(type => {
      const v = sm.validation[type];
      let status, icon;
      if (!v) {
        status = RICH_RESULT_RULES[type] ? "declared via microdata (properties not validated)" : "not a rich-result type";
        icon = chalk.gray("·");
      }
      else if (Object.keys(v.missingRequired).length) {
        const miss = Object.keys(v.missingRequired).join(", ");
        status = `missing required: ${miss}`; icon = chalk.red("✖");
      }
      else if (Object.keys(v.missingRecommended).length) {
        const miss = Object.keys(v.missingRecommended).join(", ");
        status = `missing recommended: ${miss}`; icon = chalk.yellow("⚠");
      }
      else                                          { status = "valid for rich results"; icon = chalk.green("✔"); }
      const cnt = sm.counts[type] > 1 ? chalk.gray(` ×${sm.counts[type]}`) : "";
      console.log(`    ${icon} ${type}${cnt}` + chalk.gray(` — ${status}`));
      const mdIcon = !v ? "·" : Object.keys(v.missingRequired).length ? "❌" : Object.keys(v.missingRecommended).length ? "⚠️" : "✅";
      md(`| ${mdIcon} ${type} | ${sm.counts[type]} | ${status} |`);
    });
  }

  // ── Headings
  console.log(chalk.cyan("\n  ── Headings ──────────────────────────────"));
  md("\n### Headings\n");
  if (!signals.h1.length) { console.log(chalk.red("    H1  (missing!)")); md("- ❌ **H1** _(missing!)_"); }
  signals.h1.forEach(h => { console.log(chalk.green("    H1  ") + h);  md(`- 🟢 **H1** ${h}`); });
  signals.h2.forEach(h => { console.log(chalk.yellow("    H2  ") + h); md(`- 🟡 **H2** ${h}`); });
  signals.h3.forEach(h => { console.log(chalk.gray("    H3  ")   + h); md(`-    **H3** ${h}`); });

  // ── Image alts
  if (signals.imgAlts.length) {
    console.log(chalk.cyan("\n  ── Image Alts (top 5) ────────────────────"));
    md("\n### Image Alts (top 5)\n");
    signals.imgAlts.slice(0, 5).forEach(a => {
      console.log("    " + chalk.gray("•") + " " + a);
      md(`- ${a}`);
    });
  }

  // ── Keywords
  console.log(chalk.cyan(`\n  ── Top ${TOP_N} Keywords (weighted TF-IDF) ────`));
  md(`\n### Top ${TOP_N} Keywords\n`);
  md("| Rank | Keyword | Score |");
  md("|---:|---|---:|");

  const maxScore = keywords[0]?.score || 1;
  keywords.forEach(({ kw, score }, i) => {
    const blen = Math.round((score / maxScore) * 24);
    const bar  = chalk.green("█".repeat(blen)) + chalk.gray("░".repeat(24 - blen));
    console.log(`    ${String(i+1).padStart(2)}. ${kw.padEnd(30)} ${bar}  ${chalk.white(score)}`);
    md(`| ${i+1} | ${kw} | ${score} |`);
  });

  // ── SEO Audit
  console.log(chalk.cyan("\n  ── SEO Audit ─────────────────────────────"));
  md("\n### SEO Audit\n");
  audit.issues.forEach(i => { console.log(chalk.red("    ✖ ")    + i); md(`- ❌ ${i}`); });
  audit.warns .forEach(w => { console.log(chalk.yellow("    ⚠ ") + w); md(`- ⚠️  ${w}`); });
  audit.passes.forEach(p => { console.log(chalk.green("    ✔ ")  + p); md(`- ✅ ${p}`); });

  const color = audit.seoScore >= 80 ? chalk.green : audit.seoScore >= 50 ? chalk.yellow : chalk.red;
  console.log("\n  " + color.bold(`SEO Score: ${audit.seoScore}/100`));
  md(`\n> **SEO Score: ${audit.seoScore}/100**\n`);
}

// ─── Diff ─────────────────────────────────────────────────────────────────────
function diffReports(liveS, testS, liveKws, testKws) {
  console.log("\n" + chalk.bgYellow.black.bold(" ── DIFF: live → test ── "));
  md(`\n---\n\n## DIFF: live → test\n`);

  // Signal diff
  console.log(chalk.cyan("\n  ── Signal Changes ────────────────────────"));
  md("\n### Signal Changes\n");
  const metaFields = ["title", "description", "canonical", "robots", "wordCount"];
  let changes = 0;
  metaFields.forEach(f => {
    const lv = String(liveS[f] || ""), tv = String(testS[f] || "");
    if (lv !== tv) {
      changes++;
      console.log(chalk.yellow(`\n  ↕  ${f}`));
      console.log(chalk.gray("     live: ") + lv);
      console.log(chalk.gray("     test: ") + tv);
      md(`**↕ ${f}**`);
      md(`- live: \`${lv}\``);
      md(`- test: \`${tv}\``);
      md("");
    }
  });
  if (liveS.h1.join("|") !== testS.h1.join("|")) {
    changes++;
    console.log(chalk.yellow("\n  ↕  H1"));
    console.log(chalk.gray("     live: ") + liveS.h1.join(" | "));
    console.log(chalk.gray("     test: ") + testS.h1.join(" | "));
    md("**↕ H1**");
    md(`- live: \`${liveS.h1.join(" | ")}\``);
    md(`- test: \`${testS.h1.join(" | ")}\``);
  }
  if (liveS.schemaTypes.join("|") !== testS.schemaTypes.join("|")) {
    changes++;
    const dropped = liveS.schemaTypes.filter(t => !testS.schemaTypes.includes(t));
    const gained  = testS.schemaTypes.filter(t => !liveS.schemaTypes.includes(t));
    console.log(chalk.yellow("\n  ↕  Schema.org"));
    console.log(chalk.gray("     live: ") + (liveS.schemaTypes.join(", ") || "none"));
    console.log(chalk.gray("     test: ") + (testS.schemaTypes.join(", ") || "none"));
    if (dropped.length) console.log(chalk.red("     ✖ dropped: ") + dropped.join(", "));
    if (gained.length)  console.log(chalk.green("     ✚ added:   ") + gained.join(", "));
    md("**↕ Schema.org**");
    md(`- live: \`${liveS.schemaTypes.join(", ") || "none"}\``);
    md(`- test: \`${testS.schemaTypes.join(", ") || "none"}\``);
    if (dropped.length) md(`- ❌ dropped: ${dropped.join(", ")}`);
    if (gained.length)  md(`- ✅ added: ${gained.join(", ")}`);
  }
  if (!changes) {
    console.log(chalk.green("    ✔ No meta/heading changes"));
    md("✅ No meta/heading changes");
  }

  // Keyword diff
  console.log(chalk.cyan("\n  ── Keyword Changes ───────────────────────"));
  md("\n### Keyword Changes\n");
  const liveMap = Object.fromEntries(liveKws.map(({ kw, score }) => [kw, score]));
  const testMap = Object.fromEntries(testKws.map(({ kw, score }) => [kw, score]));
  const all     = [...new Set([...Object.keys(liveMap), ...Object.keys(testMap)])];

  const added   = all.filter(k => !liveMap[k] &&  testMap[k]);
  const removed = all.filter(k =>  liveMap[k] && !testMap[k]);
  const risen   = all.filter(k =>  liveMap[k] &&  testMap[k] && testMap[k] - liveMap[k] >  0.1);
  const fallen  = all.filter(k =>  liveMap[k] &&  testMap[k] && liveMap[k] - testMap[k] >  0.1);

  if (added.length) {
    console.log(chalk.green("\n  ✚ New keywords in test:"));
    md("**✚ New keywords in test:**\n");
    added.forEach(k => {
      console.log(chalk.green(`     + ${k.padEnd(30)}`) + chalk.gray(`${testMap[k]}`));
      md(`- \`+ ${k}\` — score: ${testMap[k]}`);
    });
  }
  if (removed.length) {
    console.log(chalk.red("\n  ✖ Removed keywords:"));
    md("\n**✖ Removed keywords:**\n");
    removed.forEach(k => {
      console.log(chalk.red(`     - ${k.padEnd(30)}`) + chalk.gray(`was ${liveMap[k]}`));
      md(`- ~~${k}~~ _(was ${liveMap[k]})_`);
    });
  }
  if (risen.length) {
    console.log(chalk.green("\n  ▲ Increased weight:"));
    md("\n**▲ Increased weight:**\n");
    risen.forEach(k => {
      console.log(`     ▲ ${k.padEnd(30)} ${liveMap[k]} → ${chalk.green(testMap[k])}`);
      md(`- ▲ ${k}: ${liveMap[k]} → **${testMap[k]}**`);
    });
  }
  if (fallen.length) {
    console.log(chalk.red("\n  ▼ Decreased weight:"));
    md("\n**▼ Decreased weight:**\n");
    fallen.forEach(k => {
      console.log(`     ▼ ${k.padEnd(30)} ${liveMap[k]} → ${chalk.red(testMap[k])}`);
      md(`- ▼ ${k}: ${liveMap[k]} → ${testMap[k]}`);
    });
  }
  if (!added.length && !removed.length && !risen.length && !fallen.length) {
    console.log(chalk.green("    ✔ No significant keyword changes"));
    md("✅ No significant keyword changes");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const now = new Date().toISOString();
  md(`# 🔍 truelink SEO Report`);
  md(`\n**Generated:** ${now}`);
  md(`**Live URL:** ${LIVE_URL}`);
  if (TEST_URL) md(`**Test URL:** ${TEST_URL}`);

  console.log(chalk.bold.cyan("\n╔══════════════════════════════════════╗"));
  console.log(chalk.bold.cyan("║     🔍  truelink v2.0                ║"));
  console.log(chalk.bold.cyan("╚══════════════════════════════════════╝"));

  try {
    process.stdout.write(chalk.gray(`\nFetching LIVE: ${LIVE_URL} ...`));
    const { html: liveHtml, finalUrl: liveFinal } = await fetchPage(LIVE_URL);
    console.log(chalk.green(" ✔"));

    const live$       = cheerio.load(liveHtml);
    const liveSignals = extractSignals(live$, liveFinal);
    const liveKws     = scoreKeywords(liveSignals);
    const liveAudit   = seoAudit(liveSignals);
    printReport("LIVE", liveFinal, liveSignals, liveKws, liveAudit);

    if (TEST_URL) {
      process.stdout.write(chalk.gray(`\nFetching TEST: ${TEST_URL} ...`));
      const { html: testHtml, finalUrl: testFinal } = await fetchPage(TEST_URL);
      console.log(chalk.green(" ✔"));

      const test$       = cheerio.load(testHtml);
      const testSignals = extractSignals(test$, testFinal);
      const testKws     = scoreKeywords(testSignals);
      const testAudit   = seoAudit(testSignals);
      printReport("TEST", testFinal, testSignals, testKws, testAudit);

      diffReports(liveSignals, testSignals, liveKws, testKws);
    }

    saveMd();

    console.log(chalk.bold.cyan("\n╔══════════════════════════════════════╗"));
    console.log(chalk.bold.cyan("║  ✅  Done                             ║"));
    console.log(chalk.bold.cyan("╚══════════════════════════════════════╝\n"));

  } catch (err) {
    console.error(chalk.red("\n❌ Error:"), err.message);
    if (err.response) console.error(chalk.gray(`   HTTP ${err.response.status}`));
    process.exit(1);
  }
})();