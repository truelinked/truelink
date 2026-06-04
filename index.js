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

// ─── Schema.org extractor ─────────────────────────────────────────────────────
function extractSchema($) {
  const types = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html().replace(/[\u0000-\u001F]/g, ""));
      const t = data["@type"];
      if (t) types.push(Array.isArray(t) ? t.join(", ") : t);
    } catch {}
  });
  return types;
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
  const schemaTypes = extractSchema($);
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
    schemaTypes, socialMeta, links,
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

  if (signals.schemaTypes.length === 0) warns.push("No Schema.org structured data found");
  else passes.push(`Schema.org: ${signals.schemaTypes.join(", ")}`);

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

  logField("Title",          signals.title, titleWarn);
  logField("Description",    signals.description.slice(0, 110) + (signals.description.length > 110 ? "…" : ""), descWarn);
  logField("Canonical",      signals.canonical || "(none)", !signals.canonical);
  logField("Robots",         signals.robots || "(default: index,follow)");
  logField("hreflang",       signals.hreflang || "none");
  logField("Keywords meta",  signals.keywords || "none");
  logField("Schema",         signals.schemaTypes.join(", ") || "none", !signals.schemaTypes.length);
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
  mdField("Schema",         signals.schemaTypes.join(", ") || "none", !signals.schemaTypes.length);
  mdField("og:title",       signals.socialMeta.ogTitle || "none", !signals.socialMeta.ogTitle);
  mdField("og:image",       signals.socialMeta.ogImage ? "✔ present" : "none", !signals.socialMeta.ogImage);
  mdField("twitter:card",   signals.socialMeta.twitterCard || "none", !signals.socialMeta.twitterCard);
  mdField("Word count",     String(signals.wordCount), signals.wordCount < 100);
  mdField("Internal links", String(signals.links.internal.length));
  mdField("External links", String(signals.links.external.length));

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