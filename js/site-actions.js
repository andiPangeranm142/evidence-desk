/**
 * Site actions for Evidence Desk (spec section 1.2: capabilities owned by
 * the site and registered with the browser runtime).
 *
 * Both actions are reads over the same-origin news snapshot
 * (data/news-snapshot.json), refreshed every 6 hours by a GitHub Action
 * from public news RSS feeds. Nothing leaves the browser except the fetch
 * of that same-origin file.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'did', 'do', 'does',
  'this', 'that', 'these', 'those', 'it', 'its', 'at', 'by', 'from', 'as',
  'new', 'after', 'before', 'over', 'under', 'about', 'into', 'than',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Build the site-action catalog.
 * @param {object} opts - { snapshotUrl }
 * @returns {Array} action entries for AgentEngine
 */
export function createSiteActions({ snapshotUrl }) {
  let cached = null;
  let cachedAt = 0;
  const CACHE_MS = 5 * 60 * 1000;

  async function loadSnapshot() {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_MS) return cached;
    const res = await fetch(snapshotUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`News snapshot unavailable (HTTP ${res.status}).`);
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) {
      throw new Error('News snapshot has an unexpected shape.');
    }
    cached = data;
    cachedAt = now;
    return data;
  }

  return [
    {
      name: 'search_news_snapshot',
      description:
        'Search the site\'s recent news coverage snapshot for items matching a short keyword query. ' +
        'Returns matching headlines with source, published date, and link. Use several different ' +
        'queries to cover different angles of a claim.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Short keyword query, 2-5 words (for example "central bank rates").',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 12,
            description: 'Maximum items to return (default 8).',
          },
        },
        required: ['query'],
      },
      effect: 'read',
      async handler({ query, limit = 8 }) {
        const snapshot = await loadSnapshot();
        const tokens = tokenize(query);
        const scored = snapshot.items.map((item) => {
          const titleTokens = new Set(tokenize(item.title));
          const snippetTokens = new Set(tokenize(item.snippet || ''));
          let score = 0;
          for (const t of tokens) {
            if (titleTokens.has(t)) score += 3;
            else if (snippetTokens.has(t)) score += 1;
          }
          if (item.category && tokens.includes(item.category)) score += 1;
          return { item, score };
        });
        const results = scored
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score || String(b.item.published).localeCompare(String(a.item.published)))
          .slice(0, Math.min(limit, 12))
          .map((s) => ({
            title: s.item.title,
            source: s.item.source || hostOf(s.item.link),
            published: s.item.published,
            category: s.item.category,
            link: s.item.link,
            snippet: (s.item.snippet || '').slice(0, 220),
          }));
        return {
          ok: true,
          query,
          snapshot_generated_at: snapshot.generated_at,
          total_in_snapshot: snapshot.items.length,
          returned: results.length,
          results,
        };
      },
    },
    {
      name: 'get_snapshot_info',
      description:
        'Describe the news snapshot: when it was generated, how many items it holds, and which categories it covers.',
      parameters: { type: 'object', properties: {} },
      effect: 'read',
      async handler() {
        const snapshot = await loadSnapshot();
        return {
          ok: true,
          generated_at: snapshot.generated_at,
          total_items: snapshot.items.length,
          categories: snapshot.categories || {},
          sources: snapshot.sources || [],
          note: 'The snapshot holds recent headlines only (title, source, date, link, snippet). It is refreshed every 6 hours from public news RSS feeds.',
        };
      },
    },
  ];
}
