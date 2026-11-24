#!/usr/bin/env node
/**
 * Build data/news-snapshot.json from public news RSS feeds.
 *
 * Bing News RSS is tried first for each category (its links resolve to real
 * publisher URLs); Google News RSS is the fallback (its links still open in
 * a browser, but are obfuscated). The script writes the snapshot only when
 * the collection clears a quality bar (see MIN_* below), so a degraded run
 * never overwrites a good snapshot with a thin or stale one.
 *
 * Incident 24 Nov 2026: one scheduled run wrote only 10 stale health items
 * (Google feed down, Bing returned evergreen articles); the old "at least
 * one item" guard let it through. The quality bar below prevents that.
 *
 * No dependencies. Run: node scripts/build-news-snapshot.mjs [--out PATH]
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'data', 'news-snapshot.json');

const CATEGORIES = [
  { key: 'world', query: 'world news' },
  { key: 'technology', query: 'technology' },
  { key: 'business', query: 'business' },
  { key: 'health', query: 'health' },
  { key: 'science', query: 'science' },
];
const MAX_PER_CATEGORY = 12;
const FETCH_TIMEOUT_MS = 20000;
const RETRY_BACKOFF_MS = [10000, 25000];
// Quality bar for overwriting the live snapshot: a healthy run collects
// ~50-60 items across all 5 categories, mostly from the last day. A run
// below this bar is a degraded fetch, not real news — keep the old snapshot.
const MIN_TOTAL_ITEMS = 30;
const MIN_NONEMPTY_CATEGORIES = 3;
const MIN_RECENT_ITEMS = 5; // published within RECENT_WINDOW_MS
const RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BOT_UA = 'EvidenceDesk/1.0 (+https://github.com/andiPangeranm142/evidence-desk)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, userAgent) {
  for (const wait of [...RETRY_BACKOFF_MS, null]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': userAgent, Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (res.status === 429 || res.status === 503) {
        if (wait !== null) {
          await sleep(wait);
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (wait !== null && /429|503|abort|timeout/i.test(String(err && err.message))) {
        await sleep(wait);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('unreachable');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseItems(xmlText) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const mm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return mm ? decodeEntities(mm[1]).trim() : '';
    };
    const title = get('title');
    const link = get('link');
    if (!title || !link) continue;
    items.push({
      title,
      link,
      published: get('pubDate'),
      snippet: stripTags(get('description')).slice(0, 280),
    });
  }
  return items;
}

function bingDirectUrl(link) {
  try {
    const url = new URL(link);
    const direct = url.searchParams.get('url');
    return direct ? direct : link;
  } catch {
    return link;
  }
}

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function bingUrl(query) {
  const q = new URLSearchParams({ q: query, format: 'rss', cc: 'us', setlang: 'en' });
  return `https://www.bing.com/news/search?${q.toString()}`;
}

function googleUrl(query) {
  const q = new URLSearchParams({ q: query, hl: 'en-US', gl: 'US', ceid: 'US:en' });
  return `https://news.google.com/rss/search?${q.toString()}`;
}

async function fetchCategory(category) {
  // Bing first: real publisher URLs.
  try {
    const xml = await fetchText(bingUrl(category.query), BROWSER_UA);
    const items = parseItems(xml);
    if (items.length) {
      return {
        source: 'bing',
        items: items.slice(0, MAX_PER_CATEGORY).map((it) => ({
          ...it,
          link: bingDirectUrl(it.link),
          source: hostOf(bingDirectUrl(it.link)),
          category: category.key,
        })),
      };
    }
  } catch (err) {
    console.warn(`[snapshot] Bing failed for ${category.key}: ${err.message}`);
  }
  // Google News fallback.
  const xml = await fetchText(googleUrl(category.query), BOT_UA);
  const items = parseItems(xml);
  return {
    source: 'google',
    items: items.slice(0, MAX_PER_CATEGORY).map((it) => {
      let title = it.title;
      let source = '';
      if (title.includes(' - ')) {
        const idx = title.lastIndexOf(' - ');
        source = title.slice(idx + 3);
        title = title.slice(0, idx);
      }
      return { ...it, title, source: source || hostOf(it.link), category: category.key };
    }),
  };
}

async function main() {
  const outArg = process.argv.find((a, i) => process.argv[i - 1] === '--out');
  const outPath = outArg ? resolve(outArg) : DEFAULT_OUT;
  const items = [];
  const sources = new Set();
  const counts = {};
  const seen = new Set();

  for (const category of CATEGORIES) {
    try {
      const { source, items: found } = await fetchCategory(category);
      sources.add(source);
      let added = 0;
      for (const item of found) {
        if (seen.has(item.link)) continue;
        seen.add(item.link);
        items.push(item);
        added += 1;
      }
      counts[category.key] = added;
      console.log(`[snapshot] ${category.key}: ${added} items (${source})`);
    } catch (err) {
      counts[category.key] = 0;
      console.warn(`[snapshot] ${category.key}: failed (${err.message})`);
    }
  }

  if (items.length === 0) {
    console.error('[snapshot] No items collected from any category; keeping the previous snapshot.');
    process.exit(1);
  }

  // Quality bar: refuse to overwrite a good snapshot with a degraded one.
  const nonemptyCategories = Object.values(counts).filter((n) => n > 0).length;
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recentItems = items.filter((it) => {
    const t = Date.parse(it.published || '');
    return Number.isFinite(t) && t >= cutoff;
  }).length;
  if (items.length < MIN_TOTAL_ITEMS || nonemptyCategories < MIN_NONEMPTY_CATEGORIES || recentItems < MIN_RECENT_ITEMS) {
    console.error(
      `[snapshot] Degraded collection (${items.length} items, ${nonemptyCategories}/5 categories, ${recentItems} recent); keeping the previous snapshot.`,
    );
    process.exit(1);
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    sources: [...sources].sort(),
    categories: counts,
    items,
  };
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`[snapshot] Wrote ${items.length} items to ${outPath}`);
}

main().catch((err) => {
  console.error(`[snapshot] Fatal: ${err.message}`);
  process.exit(1);
});
