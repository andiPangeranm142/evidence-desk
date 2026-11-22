# Evidence Desk

An **open agentic website** that verifies a claim against recent news coverage.
Paste a claim — or a paragraph from an article — and a small network of agents
finds the sources, cross-checks them, and writes a sourced verdict with a
confidence score. Everything runs in the visitor's browser, on the visitor's
own model key.

Live site: **https://andipangeranm142.github.io/evidence-desk/**

Entry for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/)
(Cognizant · MIT Media Lab NANDA · Mozilla · AWS), built to the
[Open Agentic Web MVP Profile 0.3](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md).

## How it works

The agent network (`evidence_desk.network.json`, front agent
`front_desk_coordinator`) has four agents:

| Agent | Job |
|---|---|
| `front_desk_coordinator` | Runs the verification: source finding → cross-check → verdict |
| `source_finder` | Searches the site's recent-coverage snapshot via the `website_search_news_snapshot` site action |
| `cross_checker` | Compares sources: agreement, conflict, independence, gaps |
| `verdict_writer` | Writes the verdict as structured JSON: `supported` / `refuted` / `mixed` / `unverifiable`, with evidence, confidence, what would change the verdict, and limitations |

Grounding rule, enforced by the agents' instructions: agents cite **only** the
recent-coverage snapshot or text the visitor pasted. If a claim is not in the
coverage, the verdict says so — it never invents a source.

After a verdict, the visitor can request a **citation audit**: the coordinator
calls the [Citation Mirror](https://citation-mirror.vercel.app/) peer network,
which runs a six-trial spot check on the model that wrote the brief. The peer
network runs in the visitor's browser on the visitor's key, and only after the
visitor approves it on a consent card.

## Spec conformance (MVP Profile 0.3)

| Requirement | Where |
|---|---|
| Public `agent-manifest.json` | [`agent-manifest.json`](./agent-manifest.json) — network, front agent, peer allow-list, LLM router metadata |
| Resolved `.network.json` (Neuro SAN HOCON data model in JSON) | [`evidence_desk.network.json`](./evidence_desk.network.json) — fully resolved, no includes or substitutions |
| Peer link map | [`links.json`](./links.json) — maps `citation_mirror` to its public URL |
| Browser runtime | [`js/engine.js`](./js/engine.js) — an original runtime written from the spec: network validation, agent loop with streaming, local delegation, site actions, peer loading (§3.2), minimal MCP, execution bounds, consent, fail-closed errors |
| User/agent interface | [`index.html`](./index.html) + [`js/app.js`](./js/app.js) — claim input, one-tap examples, live agent activity, structured verdict card |
| LLM configuration (BYOK) | Model settings drawer — router base URL, model, key (localStorage, origin-scoped, deletable); presets for OpenRouter (`:free` models) and Mozilla Otari |
| On-device inference (experimental) | WebLLM toggle in Model settings — a small Qwen model in the browser via WebGPU, no key needed |
| Grounded capability | Site actions in [`js/site-actions.js`](./js/site-actions.js) read the same-origin news snapshot |

The site is static and served with `Access-Control-Allow-Origin: *` (GitHub
Pages), so other agentic websites can fetch its manifest and network and call
it. Peer URL: `https://andipangeranm142.github.io/evidence-desk/evidence_desk`

## News snapshot

`data/news-snapshot.json` holds recent headlines (title, source, date, link,
snippet) in five categories: world, technology, business, health, science.
It is rebuilt every 6 hours by
[`.github/workflows/news-snapshot.yml`](.github/workflows/news-snapshot.yml)
from public news RSS feeds — Bing News RSS first (real publisher URLs),
Google News RSS as fallback — by
[`scripts/build-news-snapshot.mjs`](scripts/build-news-snapshot.mjs).
The script only overwrites the snapshot when it collects at least one item,
so a failed run keeps the previous snapshot.

## Run locally

```sh
python3 -m http.server 8000
# open http://127.0.0.1:8000/
```

Add a model in **Model settings** (an OpenRouter key with a `:free` model works
without spending anything), then verify a claim.

## Tests

```sh
node --check js/engine.js js/llm.js js/site-actions.js js/app.js
node scripts/test-engine.mjs   # offline: validation, mock-LLM run, peer protocol
```

The offline tests use a scripted mock LLM and a local fixture peer site, so
they run without any API key. The live end-to-end test (real model + real
Citation Mirror peer call) is documented in the repository history.

## License

MIT — see [LICENSE](./LICENSE).
