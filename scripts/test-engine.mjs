#!/usr/bin/env node
/**
 * Offline tests for the Evidence Desk runtime (js/engine.js).
 *
 * No API key, no internet: a scripted mock LLM drives the real agent
 * network, real site actions read the real snapshot over a loopback HTTP
 * server, and a fixture peer site (tests/fixtures/peer) exercises the
 * peer-loading protocol end to end.
 *
 * Run: node scripts/test-engine.mjs
 * Exit code 0 when every check passes.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentEngine,
  EngineError,
  classifyToolRef,
  resolveNetworkPlaceholders,
  splitPeerUrl,
  validateArgs,
  validateNetwork,
} from '../js/engine.js';
import { createSiteActions } from '../js/site-actions.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok — ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL — ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
}

// --- Loopback static server for the repo root (site actions + peer fixture). ---
const MIME = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT)) throw new Error('outside root');
      const ext = file.slice(file.lastIndexOf('.'));
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

// --- Scripted mock LLM: identifies the agent from its instructions and
// returns canned tool calls / text, exercising delegation end to end. ---
const VERDICT_JSON = JSON.stringify({
  verdict: 'supported',
  confidence: 0.8,
  summary: 'Two independent outlets report the same event, matching the claim.',
  evidence: [
    {
      title: 'Test Headline',
      source: 'Test Source',
      published: '2026-11-22',
      link: 'https://example.com/1',
      supports: 'supports',
      note: 'Directly confirms the claim.',
    },
  ],
  what_would_change_verdict: 'A retraction or contradictory reporting from the same outlets.',
  limitations: 'The snapshot covers recent headlines only.',
});

class MockLlm {
  constructor() {
    this.calls = {};
    this.callCount = 0;
  }

  identify(messages) {
    const system = (messages.find((m) => m.role === 'system') || {}).content || '';
    if (system.includes('front desk coordinator')) return 'coordinator';
    if (system.includes('find news sources for a claim')) return 'source_finder';
    if (system.includes('compare the sources found')) return 'cross_checker';
    if (system.includes('final verdict for a claim')) return 'verdict_writer';
    if (system.includes('fixture peer agent')) return 'echo_peer';
    if (system.includes('MCP test agent')) return 'mcp_agent';
    return 'unknown';
  }

  async chat({ messages, onToken }) {
    this.callCount += 1;
    const agent = this.identify(messages);
    this.calls[agent] = (this.calls[agent] || 0) + 1;
    const n = this.calls[agent];
    const tool = (name, args) => ({
      content: '',
      toolCalls: [{ id: `call_${this.callCount}`, name, arguments: JSON.stringify(args) }],
    });
    const text = (content) => {
      if (onToken) onToken(content);
      return { content, toolCalls: [] };
    };
    if (agent === 'coordinator') {
      if (n === 1) return tool('source_finder', { claim: 'test claim' });
      if (n === 2) return tool('cross_checker', { claim: 'test claim', sources: 'S1' });
      if (n === 3) return tool('verdict_writer', { claim: 'test claim', sources: 'S1', cross_check: 'C1' });
      return text(`\`\`\`json\n${VERDICT_JSON}\n\`\`\``);
    }
    if (agent === 'source_finder') {
      if (n === 1) return tool('website_get_snapshot_info', {});
      if (n === 2) return tool('website_search_news_snapshot', { query: 'test claim' });
      return text('SNAPSHOT: 2026-11-22\n- Test Headline | Test Source | 2026-11-22 | https://example.com/1 | relevant');
    }
    if (agent === 'cross_checker') return text('AGREEMENT: sources agree.\nCONFLICT: NONE.\nINDEPENDENCE: 2 outlets.\nGAPS: none.');
    if (agent === 'verdict_writer') return text(`\`\`\`json\n${VERDICT_JSON}\n\`\`\``);
    if (agent === 'echo_peer') {
      const user = messages.find((m) => m.role === 'user') || {};
      return text(`FIXTURE PEER OK. Request was: ${user.content || ''}`);
    }
    if (agent === 'mcp_agent') return text('MCP tools were unavailable, so I answered without them.');
    return text('mock: unknown agent');
  }
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`loopback server on ${base}`);

  const manifest = await readJson('agent-manifest.json');
  const network = await readJson('evidence_desk.network.json');
  const links = await readJson('links.json');
  const snapshot = await readJson('data/news-snapshot.json');

  console.log('\n[1] spec artifacts');
  check('manifest has one network named evidence_desk', manifest.networks?.length === 1 && manifest.networks[0].name === 'evidence_desk');
  check('manifest front_man is front_desk_coordinator', manifest.networks[0].front_man === 'front_desk_coordinator');
  check('manifest hocon points at the network file', manifest.networks[0].hocon === './evidence_desk.network.json');
  check('manifest allow-lists Citation Mirror', (manifest.allowed_peers || []).includes('https://citation-mirror.vercel.app'));
  check('links.json maps citation_mirror to its live URL', links.networks?.evidence_desk?.citation_mirror === 'https://citation-mirror.vercel.app/citation_mirror');
  check('network has 4 agents', network.tools?.length === 4);
  check('snapshot has items in 5 categories', snapshot.items?.length >= 40 && Object.keys(snapshot.categories || {}).length === 5);

  console.log('\n[2] peer URL splitting');
  const split = splitPeerUrl('https://citation-mirror.vercel.app/citation_mirror');
  check('siteBase derived from peer URL', split.siteBase === 'https://citation-mirror.vercel.app/');
  check('networkName is the last path segment', split.networkName === 'citation_mirror');
  const split2 = splitPeerUrl('https://example.com/agents/transit');
  check('nested base path handled', split2.siteBase === 'https://example.com/agents/' && split2.networkName === 'transit');

  console.log('\n[3] JSON Schema validation');
  check('valid args pass', validateArgs({ a: 'x', b: 2 }, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] }).ok);
  check('missing required fails', !validateArgs({}, { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }).ok);
  check('wrong type fails', !validateArgs({ a: 5 }, { type: 'object', properties: { a: { type: 'string' } } }).ok);
  check('enum enforced', !validateArgs({ v: 'nope' }, { type: 'object', properties: { v: { enum: ['a', 'b'] } } }).ok);
  check('nested object validated', validateArgs({ o: { x: 1 } }, { type: 'object', properties: { o: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] } } }).ok);

  console.log('\n[4] network validation');
  const siteActions = createSiteActions({ snapshotUrl: `${base}/data/news-snapshot.json` });
  const actionMap = new Map(siteActions.map((a) => [a.name, a]));
  const okCheck = validateNetwork(network, { frontMan: 'front_desk_coordinator', siteActions: actionMap, links, networkName: 'evidence_desk' });
  check('our network validates (strict)', okCheck.ok, okCheck.errors.join('; '));
  const dup = JSON.parse(JSON.stringify(network));
  dup.tools.push(JSON.parse(JSON.stringify(dup.tools[0])));
  check('duplicate agent name rejected', !validateNetwork(dup, { frontMan: 'front_desk_coordinator', siteActions: actionMap, links, networkName: 'evidence_desk' }).ok);
  const badRef = JSON.parse(JSON.stringify(network));
  badRef.tools[0].tools.push('no_such_agent');
  check('unknown tool reference rejected', !validateNetwork(badRef, { frontMan: 'front_desk_coordinator', siteActions: actionMap, links, networkName: 'evidence_desk' }).ok);
  const badFront = validateNetwork(network, { frontMan: 'missing', siteActions: actionMap, links, networkName: 'evidence_desk' });
  check('missing front agent rejected', !badFront.ok);
  check('classifyToolRef resolves symbolic peer via links.json',
    classifyToolRef('citation_mirror', new Set(['front_desk_coordinator']), links.networks.evidence_desk).kind === 'peer');

  console.log('\n[5] placeholder resolution (peer networks with commondefs)');
  const withPlaceholders = {
    commondefs: { replacement_strings: { site_name: 'Demo', rule: 'Be brief.' } },
    tools: [{ name: 'a', function: { description: 'd' }, instructions: 'You are on {site_name}. {rule}', tools: [] }],
  };
  const resolved = resolveNetworkPlaceholders(withPlaceholders);
  check('placeholders resolved', resolved.tools[0].instructions === 'You are on Demo. Be brief.');

  console.log('\n[6] site actions against the real snapshot');
  const search = siteActions.find((a) => a.name === 'search_news_snapshot');
  const info = siteActions.find((a) => a.name === 'get_snapshot_info');
  const infoResult = await info.handler({});
  check('get_snapshot_info reports the snapshot', infoResult.ok && infoResult.total_items === snapshot.items.length);
  // Derive the query from the snapshot itself: the headlines change every
  // refresh, so a fixed keyword can silently stop matching (the old
  // 'climate talks' query failed on 25 Nov 2026 when no headline contained
  // those words). A word from the first headline always matches.
  const STOPWORDS = new Set(['with', 'were', 'have', 'this', 'that', 'these', 'those', 'from', 'after', 'before', 'over', 'under', 'about', 'into', 'than']);
  const queryWord = (snapshot.items[0]?.title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => w.length > 3 && !STOPWORDS.has(w)) || snapshot.items[0]?.category || 'news';
  const searchResult = await search.handler({ query: queryWord, limit: 5 });
  check('search_news_snapshot returns matching items', searchResult.ok && searchResult.returned > 0 && searchResult.results[0].link);
  const emptyResult = await search.handler({ query: 'zzzqqqxkcd' });
  check('search with no match returns zero items', emptyResult.ok && emptyResult.returned === 0);

  console.log('\n[7] full mock-LLM run of the network');
  const events = [];
  const mock = new MockLlm();
  const engine = new AgentEngine({
    llm: mock,
    siteActions,
    links,
    manifest,
    onEvent: (ev) => events.push(ev),
    onConsent: async () => false,
  });
  let verdictText = '';
  engine.onEvent = (ev) => {
    events.push(ev);
    if (ev.type === 'agent_end' && ev.agent === 'verdict_writer') verdictText = ev.output || '';
  };
  const run = await engine.run(network, {
    frontMan: 'front_desk_coordinator',
    networkName: 'evidence_desk',
    input: { claim: 'test claim' },
  });
  const agentsSeen = new Set(events.filter((e) => e.type === 'agent_start').map((e) => e.agent));
  check('all four agents ran', ['front_desk_coordinator', 'source_finder', 'cross_checker', 'verdict_writer'].every((a) => agentsSeen.has(a)));
  check('site action tool call dispatched', events.some((e) => e.type === 'tool_call' && e.name === 'website_search_news_snapshot'));
  check('coordinator returned the verdict JSON', run.text.includes('"verdict":"supported"'));
  check('verdict writer output parses as the verdict', JSON.parse(verdictText.match(/```json\s*([\s\S]*?)```/)[1]).verdict === 'supported');

  console.log('\n[8] peer protocol against the fixture peer');
  const testManifest = {
    ...manifest,
    allowed_peers: [`http://127.0.0.1:${port}`],
    peer_policy: { mode: 'allowlist', allow_origins: [`http://127.0.0.1:${port}`] },
  };
  const peerEngine = new AgentEngine({
    llm: new MockLlm(),
    siteActions,
    links,
    manifest: testManifest,
    onConsent: async () => true,
  });
  const ctx = { peerCache: new Map(), mcpCache: new Map(), llmCalls: 0, startedAt: Date.now(), trace: [] };
  const peer = await peerEngine.loadPeerNetwork(`${base}/tests/fixtures/peer/echo_peer`, ctx);
  check('fixture peer network loads', peer.frontMan === 'echo_peer' && peer.networkName === 'echo_peer');
  const peerOut = await peerEngine.invokeAgent('echo_peer', { request: 'hello peer' }, ctx, {
    def: peer.def, networkName: peer.networkName, origin: peer.origin, depth: 1,
  });
  check('fixture peer agent runs', peerOut.startsWith('FIXTURE PEER OK'));

  const denyEngine = new AgentEngine({ llm: new MockLlm(), siteActions, links, manifest: testManifest, onConsent: async () => false });
  let deniedCode = '';
  try {
    await denyEngine.loadPeerNetwork(`${base}/tests/fixtures/peer/echo_peer`, { peerCache: new Map(), mcpCache: new Map(), llmCalls: 0, startedAt: Date.now(), trace: [] });
  } catch (err) {
    deniedCode = err.code || '';
  }
  check('consent denied fails closed', deniedCode === 'consent-denied', deniedCode);

  let notFoundCode = '';
  try {
    await peerEngine.loadPeerNetwork(`${base}/tests/fixtures/peer/no_such_network`, { peerCache: new Map(), mcpCache: new Map(), llmCalls: 0, startedAt: Date.now(), trace: [] });
  } catch (err) {
    notFoundCode = err.code || '';
  }
  check('wrong peer network name fails (no fallback pick)', notFoundCode === 'peer-network-not-found', notFoundCode);

  const realManifestEngine = new AgentEngine({ llm: new MockLlm(), siteActions, links, manifest, onConsent: async () => true });
  let notAllowedCode = '';
  try {
    await realManifestEngine.loadPeerNetwork(`${base}/tests/fixtures/peer/echo_peer`, { peerCache: new Map(), mcpCache: new Map(), llmCalls: 0, startedAt: Date.now(), trace: [] });
  } catch (err) {
    notAllowedCode = err.code || '';
  }
  check('origin outside the allow-list refused', notAllowedCode === 'peer-origin-not-allowed', notAllowedCode);

  console.log('\n[9] MCP fail-closed');
  const mcpEvents = [];
  const mcpNetwork = {
    tools: [{
      name: 'mcp_agent',
      function: { description: 'MCP test agent', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } },
      instructions: 'MCP test agent. If your tools are unavailable, say so and answer without them.',
      tools: [{ url: 'http://127.0.0.1:9/mcp', tools: ['never'] }],
    }],
  };
  const mcpEngine = new AgentEngine({
    llm: new MockLlm(),
    siteActions,
    links,
    manifest,
    onConsent: async () => true,
    onEvent: (ev) => mcpEvents.push(ev),
  });
  const mcpOut = await mcpEngine.run(mcpNetwork, { frontMan: 'mcp_agent', networkName: 'mcp_test', input: { request: 'hi' } });
  check('unreachable MCP server does not break the run', mcpOut.text.includes('unavailable'));
  check('MCP failure reported as an event', mcpEvents.some((e) => e.type === 'mcp_error'));

  server.close();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) {
    console.log(`Failures: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Test harness error: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
