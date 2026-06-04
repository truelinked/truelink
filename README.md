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
| 📋 **Full meta audit** | Title, description, canonical, robots, hreflang, og:*, twitter:card, Schema.org |
| 🔗 **Link analysis** | Internal vs external link counts |
| 🆚 **Live vs test diff** | Keywords added, removed, risen, fallen — signal changes highlighted |
| 📄 **Markdown report** | Saved to your current folder as `truelink_YYYY-MM-DD_HH-MM-SS.md` |
| 🎯 **SEO score** | 0–100 score based on audit passes/warnings/issues |

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
  Schema            WebSite
  Word count        324

  ── Top 40 Keywords (weighted TF-IDF) ────
   1. opera                   ████████████████████████  21.17
   2. arts                    █████████████████████░░░  18.68
   3. artists                 █████████████░░░░░░░░░░░  11.63
   ...

  ── SEO Audit ─────────────────────────────
    ⚠ Title too long (83 chars, aim 50-60)
    ✔ Single H1 present
    ✔ Canonical tag present
    ✔ Schema.org: WebSite
    ✔ og:title present
    ✔ 57 internal links

  SEO Score: 91/100
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

It does one thing really well: **tell you exactly what keywords are in your SSR HTML and whether they changed.**

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