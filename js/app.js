/**
 * Evidence Desk — page application.
 *
 * Wires the original browser runtime (js/engine.js) to the page: BYOK model
 * settings, the verification flow, the agent activity timeline, the
 * verdict card, the peer citation audit, and the consent modal.
 *
 * The visitor's API key lives only in localStorage (this origin) and in
 * the LLM client instance; it is never sent anywhere except the selected
 * router, never logged, and never included in any event or trace.
 */

import { AgentEngine, EngineError } from './engine.js';
import { OpenAICompatibleClient, WebLLMClient, WEBLLM_MODEL } from './llm.js';
import { createSiteActions } from './site-actions.js';

const PROFILE_KEY = 'evidence-desk:llm-profile';
const MODE_KEY = 'evidence-desk:llm-mode';

const PRESETS = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
  },
  otari: {
    label: 'Mozilla Otari',
    baseUrl: 'https://api.otari.ai/api/v1',
    model: 'alibaba/qwen3.8-flash',
    keyUrl: 'https://otari.ai',
  },
  custom: { label: 'Custom router', baseUrl: '', model: '', keyUrl: '' },
};

const AGENT_BLURBS = {
  front_desk_coordinator: 'Running the verification',
  source_finder: 'Searching recent coverage',
  cross_checker: 'Comparing sources',
  verdict_writer: 'Writing the verdict',
  citation_mirror: 'Auditing citation behaviour (peer)',
  spot_checker: 'Running the six-trial spot check (peer)',
  answer_engine: 'Answering a spot-check trial (peer)',
};

const $ = (id) => document.getElementById(id);

const state = {
  manifest: null,
  network: null,
  links: {},
  siteActions: [],
  engine: null,
  webllm: null,
  webllmReady: false,
  sessionConsents: new Set(),
  running: false,
  claim: '',
  verdict: null, // parsed verdict JSON
  verdictRaw: '',
  auditText: '',
  activityItems: new Map(), // label -> <li>
  transcriptLength: 0,
};

// ---------------------------------------------------------------------------
// Small DOM helpers (textContent only — agent output is never injected as HTML).
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function showNotice(message, kind = 'error') {
  const n = $('notice');
  n.textContent = message;
  n.classList.toggle('info', kind === 'info');
  n.hidden = false;
  n.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideNotice() {
  $('notice').hidden = true;
}

function safeLink(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model profile (BYOK) + mode.
// ---------------------------------------------------------------------------

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.baseUrl === 'string' && typeof p.model === 'string') return p;
    return null;
  } catch {
    return null;
  }
}

function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function clearProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

function getMode() {
  return localStorage.getItem(MODE_KEY) || 'byok';
}

function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

function updateModelStatus() {
  const status = $('model-status');
  const mode = getMode();
  if (mode === 'webllm' && state.webllmReady) {
    status.textContent = `On-device · ${WEBLLM_MODEL.split('-')[0]}…`;
    status.classList.add('ok');
    return;
  }
  const profile = loadProfile();
  if (mode === 'byok' && profile && profile.apiKey) {
    let host = '';
    try {
      host = new URL(profile.baseUrl).hostname.replace(/^api\./, '');
    } catch { /* keep host empty */ }
    const model = profile.model.length > 30 ? `${profile.model.slice(0, 30)}…` : profile.model;
    status.textContent = `${host || 'BYOK'} · ${model}`;
    status.classList.add('ok');
    return;
  }
  status.textContent = 'No model configured';
  status.classList.remove('ok');
}

function buildLlmClient() {
  const mode = getMode();
  if (mode === 'webllm') {
    if (!state.webllmReady || !state.webllm) {
      throw new EngineError(
        'The on-device model is selected but not loaded yet. Open Model settings and load it first.',
        'webllm-not-ready',
      );
    }
    return state.webllm;
  }
  const profile = loadProfile();
  if (!profile || !profile.baseUrl || !profile.model) {
    throw new EngineError(
      'No model is configured yet. Open Model settings and add a router, model, and API key.',
      'no-model',
    );
  }
  if (!profile.apiKey) {
    throw new EngineError(
      'No API key is saved. Open Model settings and add your key (free :free models on OpenRouter need a key too).',
      'no-key',
    );
  }
  return new OpenAICompatibleClient({
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    extraHeaders: profile.baseUrl.includes('openrouter.ai')
      ? { 'HTTP-Referer': 'https://andipangeranm142.github.io/evidence-desk/', 'X-Title': 'Evidence Desk' }
      : {},
  });
}

// ---------------------------------------------------------------------------
// Consent modal: the runtime asks before any third-party contact.
// ---------------------------------------------------------------------------

let consentResolve = null;

function askConsent({ kind, origin, purpose }) {
  if (state.sessionConsents.has(origin)) return Promise.resolve(true);
  return new Promise((resolve) => {
    consentResolve = resolve;
    $('consent-origin').textContent = origin;
    $('consent-purpose').textContent = purpose;
    const modal = $('consent-modal');
    modal.hidden = false;
    $('consent-once').focus();
  });
}

function closeConsent(decision) {
  $('consent-modal').hidden = true;
  if (consentResolve) {
    const resolve = consentResolve;
    consentResolve = null;
    resolve(decision);
  }
}

// ---------------------------------------------------------------------------
// Engine + activity timeline.
// ---------------------------------------------------------------------------

function makeEngine() {
  const llm = buildLlmClient();
  return new AgentEngine({
    llm,
    siteActions: state.siteActions,
    links: state.links,
    manifest: state.manifest,
    onConsent: async ({ origin, purpose }) => askConsent({ origin, purpose }),
    onEvent: handleEngineEvent,
  });
}

function resetActivity(heading) {
  $('activity').hidden = false;
  $('activity-list').replaceChildren();
  $('live-transcript').textContent = '';
  state.transcriptLength = 0;
  state.activityItems.clear();
  const status = $('activity-status');
  status.textContent = heading || 'Running…';
  status.className = 'activity-status running';
  $('activity').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function activityItem(label, blurb) {
  let li = state.activityItems.get(label);
  if (li) return li;
  li = el('li', 'running');
  li.appendChild(el('span', 'activity-dot'));
  const agent = el('span', 'activity-agent', label);
  const detail = el('span', 'activity-detail', blurb || 'Working…');
  li.append(agent, detail);
  $('activity-list').appendChild(li);
  state.activityItems.set(label, li);
  return li;
}

function setItemDone(label, note) {
  const li = state.activityItems.get(label);
  if (!li) return;
  li.classList.remove('running');
  li.classList.add('done');
  if (note) li.querySelector('.activity-detail').textContent = note;
}

function setItemFailed(label, note) {
  const li = state.activityItems.get(label);
  if (!li) return;
  li.classList.remove('running');
  li.classList.add('failed');
  if (note) li.querySelector('.activity-detail').textContent = note;
}

function appendTranscript(text) {
  const pre = $('live-transcript');
  const next = `${pre.textContent}${text}`;
  pre.textContent = next.length > 9000 ? next.slice(next.length - 9000) : next;
  pre.scrollTop = pre.scrollHeight;
}

function handleEngineEvent(ev) {
  switch (ev.type) {
    case 'agent_start': {
      const label = ev.origin === 'local' ? ev.agent : `${ev.network}/${ev.agent}`;
      activityItem(label, AGENT_BLURBS[ev.agent] || 'Working…');
      appendTranscript(`\n— ${label} started —\n`);
      break;
    }
    case 'agent_end': {
      const label = ev.origin === 'local' ? ev.agent : `${ev.network}/${ev.agent}`;
      setItemDone(label, 'Done.');
      if (ev.agent === 'verdict_writer' && ev.origin === 'local') {
        state.verdictRaw = ev.output || '';
      }
      if (ev.agent === 'citation_mirror') {
        state.auditText = ev.output || '';
      }
      appendTranscript(`\n— ${label} finished —\n`);
      break;
    }
    case 'token':
      appendTranscript(ev.text || '');
      break;
    case 'tool_call': {
      appendTranscript(`\n[tool call] ${ev.name}\n`);
      break;
    }
    case 'tool_result': {
      const snippet = String(ev.result || '').replace(/\s+/g, ' ').slice(0, 220);
      appendTranscript(`[tool result] ${ev.name}: ${snippet}\n`);
      break;
    }
    case 'peer_manifest_fetch':
      activityItem(`peer ${ev.networkName}`, `Loading the peer network from ${ev.siteBase}`);
      appendTranscript(`\n[peer] loading ${ev.networkName} from ${ev.siteBase}\n`);
      break;
    case 'peer_warning':
      appendTranscript(`\n[peer warning] ${ev.warning}\n`);
      break;
    case 'mcp_error':
      appendTranscript(`\n[MCP unavailable] ${ev.error}\n`);
      break;
    case 'run_end': {
      const status = $('activity-status');
      status.textContent = `Done · ${ev.llmCalls} model call${ev.llmCalls === 1 ? '' : 's'} · ${Math.round(ev.elapsedMs / 1000)}s`;
      status.className = 'activity-status done';
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Verdict extraction + rendering.
// ---------------------------------------------------------------------------

const VERDICTS = ['supported', 'refuted', 'mixed', 'unverifiable'];

function extractVerdictJson(text) {
  if (!text) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && VERDICTS.includes(parsed.verdict) && typeof parsed.summary === 'string') {
        return {
          verdict: parsed.verdict,
          confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
          summary: parsed.summary,
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
          what_would_change_verdict: parsed.what_would_change_verdict || '',
          limitations: parsed.limitations || '',
        };
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

function verdictToMarkdown() {
  const v = state.verdict;
  if (!v) return '';
  const lines = [
    `# Verdict: ${v.verdict} (${Math.round(v.confidence * 100)}% confidence)`,
    '',
    `Claim: ${state.claim}`,
    '',
    v.summary,
    '',
    '## Evidence',
  ];
  if (v.evidence.length === 0) lines.push('', 'No sources found in recent coverage.');
  for (const e of v.evidence) {
    lines.push('', `- [${e.title || 'Untitled'}](${e.link || ''}) — ${e.source || ''}, ${e.published || ''} (${e.supports || 'context'}). ${e.note || ''}`);
  }
  lines.push('', `## What would change this verdict`, '', v.what_would_change_verdict || '—');
  lines.push('', '## Limitations', '', v.limitations || '—');
  if (state.auditText) lines.push('', '## Citation audit (Citation Mirror peer)', '', state.auditText);
  lines.push('', '— Verified by Evidence Desk (https://andipangeranm142.github.io/evidence-desk/)');
  return lines.join('\n');
}

function renderVerdict() {
  const section = $('verdict');
  const card = $('verdict-card');
  card.replaceChildren();
  section.hidden = false;

  const v = state.verdict;
  if (!v) {
    const box = el('div', 'verdict-card');
    const head = el('div', 'verdict-head');
    head.appendChild(el('span', 'verdict-badge verdict-unverifiable', 'No structured verdict'));
    box.appendChild(head);
    const note = el('p', 'verdict-summary',
      'The agents finished, but the verdict did not come back as structured data. The raw answer is below — it may still be useful, but it was not rendered as a verdict card.');
    box.appendChild(note);
    const raw = el('pre', 'raw-verdict', state.verdictRaw || '(no output)');
    box.appendChild(raw);
    card.appendChild(box);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const box = el('div', 'verdict-card');

  const head = el('div', 'verdict-head');
  const badge = el('span', `verdict-badge verdict-${v.verdict}`, v.verdict);
  head.appendChild(badge);
  const claimP = el('p', 'verdict-claim');
  claimP.append('Claim: ');
  claimP.appendChild(el('strong', null, state.claim));
  head.appendChild(claimP);
  box.appendChild(head);

  const conf = el('div', 'confidence');
  const confLabel = el('div', 'confidence-label');
  confLabel.append(el('span', null, 'Confidence'), el('span', null, `${Math.round(v.confidence * 100)}%`));
  const bar = el('div', 'confidence-bar');
  const fill = el('div', 'confidence-fill');
  fill.style.width = `${Math.round(v.confidence * 100)}%`;
  bar.appendChild(fill);
  conf.append(confLabel, bar);
  box.appendChild(conf);

  box.appendChild(el('p', 'verdict-summary', v.summary));

  const body = el('div', 'verdict-body');
  body.appendChild(el('h3', null, `Evidence (${v.evidence.length})`));
  if (v.evidence.length === 0) {
    body.appendChild(el('p', 'verdict-note', 'No sources in recent coverage matched this claim. The verdict is unverifiable from the snapshot — not proof the claim is false.'));
  } else {
    const list = el('ol', 'evidence-list');
    for (const e of v.evidence) {
      const li = el('li');
      const title = el('span', 'evidence-title');
      const href = safeLink(e.link || '');
      if (href) {
        const a = el('a', null, e.title || 'Untitled');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        title.appendChild(a);
      } else {
        title.textContent = e.title || 'Untitled';
      }
      const tag = el('span', `evidence-tag tag-${['supports', 'refutes'].includes(e.supports) ? e.supports : 'context'}`, e.supports || 'context');
      title.appendChild(tag);
      li.appendChild(title);
      li.appendChild(el('div', 'evidence-meta', `${e.source || 'Unknown source'} · ${e.published || 'date unknown'}`));
      if (e.note) li.appendChild(el('div', 'evidence-note', e.note));
      list.appendChild(li);
    }
    body.appendChild(list);
  }
  if (v.what_would_change_verdict) {
    body.appendChild(el('h3', null, 'What would change this verdict'));
    body.appendChild(el('p', 'verdict-note', v.what_would_change_verdict));
  }
  if (v.limitations) {
    body.appendChild(el('h3', null, 'Limitations'));
    body.appendChild(el('p', 'verdict-note', v.limitations));
  }
  box.appendChild(body);

  const actions = el('div', 'verdict-actions');
  const auditBtn = el('button', 'btn btn-secondary', 'Audit this brief’s citations');
  auditBtn.type = 'button';
  auditBtn.id = 'audit-btn';
  auditBtn.addEventListener('click', runAudit);
  const copyBtn = el('button', 'btn btn-ghost', 'Copy brief as Markdown');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(verdictToMarkdown());
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy brief as Markdown'; }, 2000);
    } catch {
      showNotice('Could not copy to the clipboard in this browser.', 'error');
    }
  });
  const againBtn = el('button', 'btn btn-ghost', 'Verify another claim');
  againBtn.type = 'button';
  againBtn.addEventListener('click', () => {
    $('claim-input').focus();
    $('claim-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  actions.append(auditBtn, copyBtn, againBtn);
  box.appendChild(actions);

  if (state.auditText) box.appendChild(renderAuditBox(state.auditText));
  card.appendChild(box);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAuditBox(text) {
  const box = el('div', 'audit-box');
  box.appendChild(el('h3', null, 'Citation audit — Citation Mirror peer network'));
  for (const para of String(text).split(/\n\s*\n/).filter((p) => p.trim())) {
    box.appendChild(el('p', null, para.trim()));
  }
  box.appendChild(el('p', 'fineprint',
    'This spot check measures the model that wrote the brief: whether it prefers pages written by its own developer’s model, or the page listed first. It is indicative only — the calibrated test runs on the Citation Mirror page.'));
  return box;
}

// ---------------------------------------------------------------------------
// Verify + audit flows.
// ---------------------------------------------------------------------------

async function runVerify() {
  if (state.running) return;
  const claim = $('claim-input').value.trim();
  if (!claim) {
    showNotice('Enter a claim (or paste article text) first.');
    $('claim-input').focus();
    return;
  }
  let engine;
  try {
    engine = makeEngine();
  } catch (err) {
    showNotice(err.message || String(err));
    openSettings();
    return;
  }
  state.running = true;
  state.claim = claim;
  state.verdict = null;
  state.verdictRaw = '';
  state.auditText = '';
  hideNotice();
  $('verify-btn').disabled = true;
  $('verdict').hidden = true;
  resetActivity('Running…');
  try {
    const { text } = await engine.run(state.network, {
      frontMan: state.manifest.networks[0].front_man,
      networkName: state.manifest.networks[0].name,
      input: { claim },
    });
    state.verdict = extractVerdictJson(state.verdictRaw) || extractVerdictJson(text);
    if (!state.verdictRaw) state.verdictRaw = text;
    renderVerdict();
  } catch (err) {
    const status = $('activity-status');
    status.textContent = 'Failed';
    status.className = 'activity-status';
    for (const label of state.activityItems.keys()) setItemFailed(label, 'Stopped.');
    showNotice(`Verification failed: ${err.message || err}`);
  } finally {
    state.running = false;
    $('verify-btn').disabled = false;
  }
}

async function runAudit() {
  if (state.running || !state.verdict) return;
  let engine;
  try {
    engine = makeEngine();
  } catch (err) {
    showNotice(err.message || String(err));
    openSettings();
    return;
  }
  state.running = true;
  state.auditText = '';
  hideNotice();
  const btn = $('audit-btn');
  if (btn) btn.disabled = true;
  resetActivity('Auditing citations (peer)…');
  try {
    const { text } = await engine.run(state.network, {
      frontMan: state.manifest.networks[0].front_man,
      networkName: state.manifest.networks[0].name,
      input: {
        claim: state.claim,
        audit_citations: true,
        prior_verdict: JSON.stringify(state.verdict),
      },
    });
    // The audit summary is the coordinator's text with the verdict JSON removed.
    const summary = String(text || '')
      .replace(/```json\s*[\s\S]*?```/gi, '')
      .replace(/```\s*[\s\S]*?```/g, '')
      .trim();
    state.auditText = state.auditText || summary;
    if (!state.auditText) {
      state.auditText = 'The peer network returned no audit summary. The spot check may have been declined or failed; see the activity log above.';
    }
    renderVerdict();
  } catch (err) {
    const status = $('activity-status');
    status.textContent = 'Audit failed';
    status.className = 'activity-status';
    state.auditText = `The citation audit could not run: ${err.message || err}`;
    renderVerdict();
  } finally {
    state.running = false;
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Settings drawer.
// ---------------------------------------------------------------------------

function fillSettingsFromProfile() {
  const profile = loadProfile();
  const preset = profile && profile.provider && PRESETS[profile.provider] ? profile.provider : null;
  document.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });
  $('router-url').value = profile ? profile.baseUrl : PRESETS.openrouter.baseUrl;
  $('model-name').value = profile ? profile.model : PRESETS.openrouter.model;
  $('api-key').value = profile && profile.apiKey ? profile.apiKey : '';
  $('profile-status').textContent = profile && profile.apiKey
    ? `Saved model: ${profile.model}`
    : 'No key saved yet.';
  $('profile-status').className = 'profile-status';
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
  if (name !== 'custom') {
    $('router-url').value = preset.baseUrl;
    $('model-name').value = preset.model;
  }
  $('api-key').focus();
}

function openSettings() {
  fillSettingsFromProfile();
  updateWebllmStatus();
  $('settings-drawer').hidden = false;
  $('router-url').focus();
}

function closeSettings() {
  $('settings-drawer').hidden = true;
}

function updateWebllmStatus() {
  const status = $('webllm-status');
  const initBtn = $('webllm-init');
  if (!WebLLMClient.isSupported()) {
    status.textContent = 'This browser does not expose WebGPU, so the on-device model is unavailable here. Use a BYOK router instead.';
    status.className = 'profile-status';
    initBtn.disabled = true;
    return;
  }
  initBtn.disabled = false;
  if (state.webllmReady) {
    status.textContent = `On-device model loaded: ${WEBLLM_MODEL}. It is active when “Use BYOK instead” has not been chosen.`;
    status.className = 'profile-status ok';
  } else if (getMode() === 'webllm') {
    status.textContent = 'On-device mode is selected, but the model has not finished loading yet.';
    status.className = 'profile-status';
  } else {
    status.textContent = `Model: ${WEBLLM_MODEL} (about 1 GB download on first use).`;
    status.className = 'profile-status';
  }
}

async function initWebllm() {
  const status = $('webllm-status');
  const progress = $('webllm-progress');
  const initBtn = $('webllm-init');
  initBtn.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  status.textContent = 'Loading the on-device engine…';
  status.className = 'profile-status';
  try {
    if (!state.webllm) {
      state.webllm = new WebLLMClient({
        onProgress: (report) => {
          if (report && typeof report.progress === 'number') progress.value = report.progress;
          if (report && report.text) status.textContent = report.text;
        },
      });
    }
    await state.webllm.init();
    state.webllmReady = true;
    setMode('webllm');
    progress.hidden = true;
    status.textContent = 'On-device model loaded and active.';
    status.className = 'profile-status ok';
    updateModelStatus();
  } catch (err) {
    progress.hidden = true;
    status.textContent = `Could not load the on-device model: ${err.message || err}`;
    status.className = 'profile-status error';
    initBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

async function loadSnapshotBadge() {
  const badge = $('snapshot-badge');
  try {
    const res = await fetch('./data/news-snapshot.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    const date = new Date(snap.generated_at);
    const when = Number.isNaN(date.getTime())
      ? snap.generated_at
      : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const cats = snap.categories ? Object.keys(snap.categories).join(', ') : '';
    badge.innerHTML = '';
    badge.append(
      'Coverage snapshot: ',
      el('strong', null, `${snap.items.length} headlines`),
      ` · refreshed ${when} · ${cats}`,
    );
  } catch {
    badge.textContent = 'Coverage snapshot unavailable — the agents will say so rather than invent sources.';
  }
}

async function boot() {
  // Load the public spec artifacts (same files other sites fetch).
  try {
    const [manifestRes, networkRes, linksRes] = await Promise.all([
      fetch('./agent-manifest.json'),
      fetch('./evidence_desk.network.json'),
      fetch('./links.json'),
    ]);
    if (!manifestRes.ok || !networkRes.ok || !linksRes.ok) {
      throw new Error('Could not load the agent network files.');
    }
    state.manifest = await manifestRes.json();
    state.network = await networkRes.json();
    state.links = await linksRes.json();
  } catch (err) {
    showNotice(`This site could not load its own agent network: ${err.message || err}`);
    $('verify-btn').disabled = true;
    return;
  }
  state.siteActions = createSiteActions({ snapshotUrl: './data/news-snapshot.json' });

  // Restore saved model settings (key stays in the browser).
  fillSettingsFromProfile();
  updateModelStatus();
  updateWebllmStatus();
  loadSnapshotBadge();

  $('verify-btn').addEventListener('click', runVerify);
  $('claim-input').addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') runVerify();
  });
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('claim-input').value = chip.dataset.claim;
      runVerify();
    });
  });

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-drawer').addEventListener('click', (ev) => {
    if (ev.target === $('settings-drawer')) closeSettings();
  });
  document.querySelectorAll('.preset').forEach((b) => {
    b.addEventListener('click', () => applyPreset(b.dataset.preset));
  });
  $('save-profile').addEventListener('click', () => {
    const baseUrl = $('router-url').value.trim().replace(/\/+$/, '');
    const model = $('model-name').value.trim();
    const apiKey = $('api-key').value.trim();
    const status = $('profile-status');
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad protocol');
    } catch {
      status.textContent = 'Enter a valid router base URL (for example https://openrouter.ai/api/v1).';
      status.className = 'profile-status error';
      return;
    }
    if (!model) {
      status.textContent = 'Enter a model name.';
      status.className = 'profile-status error';
      return;
    }
    if (!apiKey) {
      status.textContent = 'Enter your API key. It is stored only in this browser.';
      status.className = 'profile-status error';
      return;
    }
    const activePreset = document.querySelector('.preset.active');
    saveProfile({
      provider: activePreset ? activePreset.dataset.preset : 'custom',
      baseUrl,
      model,
      apiKey,
    });
    setMode('byok');
    updateModelStatus();
    status.textContent = 'Saved. This model is now active.';
    status.className = 'profile-status ok';
    setTimeout(closeSettings, 500);
  });
  $('clear-profile').addEventListener('click', () => {
    clearProfile();
    $('api-key').value = '';
    updateModelStatus();
    const status = $('profile-status');
    status.textContent = 'Saved key deleted from this browser.';
    status.className = 'profile-status';
  });
  $('webllm-init').addEventListener('click', initWebllm);
  $('webllm-disable').addEventListener('click', () => {
    setMode('byok');
    updateModelStatus();
    updateWebllmStatus();
    $('profile-status').textContent = 'BYOK mode selected. Save a router and key above to verify claims.';
  });

  $('consent-once').addEventListener('click', () => closeConsent(true));
  $('consent-session').addEventListener('click', () => {
    state.sessionConsents.add($('consent-origin').textContent);
    closeConsent(true);
  });
  $('consent-deny').addEventListener('click', () => closeConsent(false));
  $('consent-modal').addEventListener('click', (ev) => {
    if (ev.target === $('consent-modal')) closeConsent(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('consent-modal').hidden) closeConsent(false);
    else if (!$('settings-drawer').hidden) closeSettings();
  });
}

boot().catch((err) => {
  showNotice(`This site failed to start: ${err.message || err}`);
});
