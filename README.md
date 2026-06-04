# 🔍 truelink

> **The no-BS SEO keyword extractor and diff tool for engineers.**  
> SSR-only. No browser. No Puppeteer. No bullshit.

```bash
npx truelink https://yoursite.com/page
npx truelink https://live.yoursite.com/page https://staging.yoursite.com/page
```

---

## Why

Most SEO tools are built for marketers — dashboards, subscriptions, 47 tabs open.  
**truelink** is built for developers who want to:

- Extract real keywords from a page in seconds
- Compare live vs staging before a deploy
- Catch SEO regressions in CI or a quick terminal check
- Get a clean `.md` report they can drop in a PR

---

## What it does

Fetches your page via SSR (raw HTML, no JS execution), strips all the React/Next.js bundle noise, and gives you:

| Feature | Details |
|---|---|
| 🧠 **Keyword extraction** | Weighted TF-IDF across title (5×), headings (4×), description (3×), alts (2×), body (1×) |
| 🔤 **Bigram detection** | Finds meaningful two-word phrases that appear 2+ times |
| 🌿 **Stem deduplication** | `artist` and `artists` won't both appear — best form wins |
| 📋 **Full meta audit** | Title, description, canonical, robots, hreflang, og:*, twitter:card |
| 🏷️ **Structured data validator** | Recursively parses every JSON-LD block (incl. `@graph`, arrays, nested entities) + Microdata/RDFa, then checks each type against Google rich-result required/recommended properties |
| 🔗 **Link analysis** | Internal vs external link counts |
| 📦 **SSR readiness** | Page size, bytes per word, content density, % JavaScript, and a blunt render verdict (`LEAN` / `HEAVY` / `BLOATED` / `CSR SHELL`) |
| 🆚 **Live vs test diff** | Keywords + schema + **indexable-content/payload** changes (words, content density, page size, bytes/word, content score) highlighted |
| 📄 **Markdown report** | Saved to your current folder as `truelink_YYYY-MM-DD_HH-MM-SS.md` |
| 🎯 **Two scores** | **Technical SEO** (tag/meta hygiene) and **Content / SSR readiness** (real content plus payload quality in the raw HTML) — kept separate so good tags can't mask bad rendering |

---

## Install

No install needed — just run with `npx`:

```bash
npx truelink <url> [test-url]
```

Or install globally if you use it daily:

```bash
npm install -g truelink
truelink https://yoursite.com/page
```

---

## Usage

### Analyse a single page
```bash
npx truelink https://yoursite.com/en
```

### Compare live vs staging
```bash
npx truelink https://yoursite.com/en https://staging.yoursite.com/en
```

Works on internal/staging domains too — self-signed SSL certs are handled automatically.

---

## Output

### Terminal
Color-coded live report with keyword bar charts, heading hierarchy, and audit checklist.

```
╔══════════════════════════════════════╗
║     🔍  truelink v2.0               ║
╚══════════════════════════════════════╝

Fetching LIVE: https://yoursite.com/en ... ✔

 ── LIVE ──  https://yoursite.com/en

  ── Meta ──────────────────────────────────
  Title             Your Page Title ⚠
  Description       Your meta description...
  Canonical         https://yoursite.com/en
  Schema            WebSite, Organization, BreadcrumbList  (3 types, 1 JSON-LD block)
  Word count        324
  Payload           48.2 KB · 152 B/word · 61% JS
  Content density   14.6% text vs markup
  Render            Next.js · LEAN
    152 B per word, 61% JavaScript — content-first HTML, crawler-friendly.

  ── Top 40 Keywords (weighted TF-IDF) ────
   1. opera                   ████████████████████████  21.17
   2. arts                    █████████████████████░░░  18.68
   3. artists                 █████████████░░░░░░░░░░░  11.63
   ...

  ── Structured Data ───────────────────────
    1 JSON-LD block(s)
    ✔ WebSite — valid for rich results
    ✔ Organization — valid for rich results
    ✖ BreadcrumbList — missing required: itemListElement

  ── SEO Audit ─────────────────────────────
    ⚠ Title too long (83 chars, aim 50-60)
    ✔ Single H1 present
    ✔ Canonical tag present
    ✖ BreadcrumbList: missing required itemListElement — not eligible for rich results
    ✔ og:title present
    ✔ 57 internal links
    ✔ LEAN: 152 B per word, 61% JavaScript — content-first HTML, crawler-friendly.

  Technical SEO (tags/meta): 91/100
  Content / SSR readiness:   83/100   (density 36/45 · content 30/35 · headings 12/12 · links 5/8)
```

### Why two scores?

`Technical SEO` measures **tag hygiene** — is the title/description/canonical/og/schema correct. A page can score 90+ here while being nearly empty, because all it checks is that the right tags exist.

`Content / SSR readiness` measures **how much real, indexable content is in the raw HTML** — what a crawler sees with **no JavaScript executed**. It reports it bluntly: **bytes of HTML shipped per indexable word** and **% of the page that is JavaScript**, plus a one-line verdict (`LEAN` / `HEAVY` / `BLOATED` / `CSR SHELL`). A client-side-rendered page ships an empty shell behind a big JS bundle, so it lands a brutal bytes-per-word number and a low score even when the tags are perfect. We deliberately avoid a single text/total-HTML percentage — real JS apps pin that near 0%, and a number that never moves gets ignored.

| Verdict | Meaning |
|---|---|
| `LEAN` | Content-first HTML, crawler-friendly |
| `HEAVY` | Content is present but buried under markup/JS — trim the payload |
| `BLOATED` | You're shipping a JS bundle to surface a paragraph (>2 KB/word or ≥90% JS) |
| `CSR SHELL` | The content isn't server-rendered at all — a crawler sees an empty shell |

```
  ── Indexable content & payload
     ▲ words:          233 → 1536  (6.6×)
     ▼ page size:      351.6 KB → 2.50 MB
     ▼ bytes/word:     1.5 KB → 1.7 KB
     ▲ content score:  32 → 58
```

Every run with two URLs ends with a **side-by-side scorecard** so the actual difference is unambiguous — including when "newer" isn't strictly "better":

```
 ── SCORECARD: live vs test ──
  Metric           LIVE         TEST         Winner
  Technical SEO    88/100       85/100       → live
  Content / SSR    32/100       50/100       → test
  Words            233          1536         → test
  Page size        351.6 KB     2.50 MB      → live
  Bytes / word     1.5 KB       1.7 KB       → live
  JavaScript       87%          92%          → live
  Schema types     9            9            =
  Internal links   48           283          → test
  Render verdict   HEAVY        BLOATED      =

  Net  →  Technical SEO -3   ·   Content/SSR +18   (test wins 4, live wins 4)
```

### Markdown file
Saved automatically to your current working directory:

```
truelink_2026-06-04_09-22-00.md
```

Clean tables, emoji audit icons, diff sections — ready to paste into a PR, Notion, or GitHub comment.

---

## Diff output

When comparing two URLs, truelink shows exactly what changed:

```
 ── DIFF: live → test ──

  ── Signal Changes ────────────────────────
  ↕  description
     live: "...With over 1,126,096 performances, 591,138 artists..."
     test: "...With over performances, artists..."   ← ⚠️ missing dynamic counts

  ── Keyword Changes ───────────────────────
  ✚ New keywords in test:
     + industry professionals          4.5
     + arts organisations              4.5

  ✖ Removed keywords:
     - organisation                    was 9.44

  ▲ Increased weight:
     ▲ performances    8.39 → 10.53
     ▲ casting tool    4.50 → 6.00
```

---

## How keyword scoring works

truelink uses a weighted TF-IDF pipeline, not a simple word count:

1. **Extract** — strips all `<script>`, `<style>`, camelCase tokens, unicode escapes, and known JS/React noise
2. **Space-aware parsing** — elements are extracted individually so `<a>Tools</a><a>Talent</a>` becomes `"Tools Talent"` not `"ToolsTalent"`
3. **Weight** — tokens from title, headings, and description are repeated proportionally before scoring
4. **Score** — `TF-IDF × log(1 + frequency)` balances rarity with repetition
5. **Bigrams** — two-word phrases appearing 2+ times are scored separately with a boost
6. **Stem dedup** — Porter Stemmer collapses variants; highest-scoring surface form is kept

---

## What truelink won't do

- ❌ Execute JavaScript (use Playwright for that)
- ❌ Check Google rankings (use Ahrefs/SEMrush for that)
- ❌ Crawl multiple pages (run it per-page)
- ❌ Replace a full SEO platform

It does one thing really well: **tell you what a crawler actually gets from the raw HTML, and whether live → test made that better or worse.**

---

## Requirements

- Node.js 18+
- Network access to the target URL

---

## License

MIT — do whatever you want with it.

---

<p align="center">
  Built for engineers who'd rather run a command than open a dashboard.
</p>