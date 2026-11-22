/**
 * Evidence Desk — original browser runtime for the Open Agentic Web,
 * MVP Profile 0.3 (Cognizant AI Lab, 18 November 2026).
 *
 * Written from scratch from the published specification. No dependencies,
 * no copied runtime code. DOM-free: it runs in a browser and in Node 20+
 * (the Node path is used by the project's offline tests).
 *
 * What it does:
 *  - loads and validates a resolved agent-network definition (Neuro SAN
 *    HOCON data model serialised as JSON) and its agent-manifest.json
 *  - runs the network's front agent in the browser with an OpenAI-compatible
 *    LLM client (BYOK) or any client implementing the same chat() interface
 *  - dispatches local agent delegation, registered site actions
 *    (website_* tools), peer-network calls by URL, and minimal MCP calls
 *  - enforces execution bounds, peer allow-lists, and visitor consent
 *    before any contact with a third-party origin, and fails closed with
 *    clear errors whenever a call cannot be safely validated or authorised
 *
 * What it never does:
 *  - it never sees, stores, or transmits an LLM API key (keys live in the
 *    LLM client, which is configured by the visitor in the page settings)
 *  - it never executes publisher-supplied code; networks are data only
 *  - it never retries a write whose outcome is unknown
 */

/** Error type for every fail-closed runtime failure. `code` is stable. */
export class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EngineError';
    this.code = code || 'engine-error';
  }
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validation (enough for agent and tool parameters).
// Supports: type, required, properties, items, enum, minimum, maximum,
// minLength, maxLength, minItems, maxItems, additionalProperties: false.
// Returns { ok: true } or { ok: false, errors: [string, ...] }.
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, expected) {
  if (expected === 'number') return typeof value === 'number';
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOf(value) === expected;
}

export function validateArgs(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { ok: true };
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected type ${types.join(' or ')}, got ${typeOf(value)}`);
      return { ok: false, errors };
    }
  }
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        const r = validateArgs(item, schema.items, `${path}[${i}]`);
        if (!r.ok) errors.push(...r.errors);
      });
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value) || value[req] === undefined) {
        errors.push(`${path}: missing required property "${req}"`);
      }
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value && value[key] !== undefined) {
        const r = validateArgs(value[key], sub, `${path}.${key}`);
        if (!r.ok) errors.push(...r.errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}: additional property "${key}" not allowed`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---------------------------------------------------------------------------
// Placeholder resolution for peer networks that still carry
// commondefs.replacement_strings (the profile requires published files to be
// fully resolved, but a tolerant runtime resolves them instead of failing).
// ---------------------------------------------------------------------------

function replaceInStrings(node, replacements) {
  if (typeof node === 'string') {
    let out = node;
    for (const [key, val] of Object.entries(replacements)) {
      if (typeof val === 'string') out = out.split(`{${key}}`).join(val);
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((n) => replaceInStrings(n, replacements));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = replaceInStrings(v, replacements);
    return out;
  }
  return node;
}

export function resolveNetworkPlaceholders(def) {
  const reps = def && def.commondefs && def.commondefs.replacement_strings;
  if (!reps || typeof reps !== 'object') return def;
  return replaceInStrings(def, reps);
}

// ---------------------------------------------------------------------------
// Peer URLs: the final path component is the network name; the preceding
// path is the site base that serves agent-manifest.json (spec section 3.2).
// ---------------------------------------------------------------------------

export function splitPeerUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new EngineError(`Not a valid peer URL: ${url}`, 'invalid-peer-url');
  }
  const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new EngineError(`Peer URL has no network name: ${url}`, 'invalid-peer-url');
  }
  const networkName = parts[parts.length - 1];
  const basePath = parts.slice(0, -1).join('/');
  const siteBase = `${parsed.origin}/${basePath ? `${basePath}/` : ''}`;
  return { siteBase, networkName, origin: parsed.origin };
}

// ---------------------------------------------------------------------------
// Network validation (spec sections 2.1-2.2, 3.1).
// `siteActions` is a Map of registered website_* actions; for peer networks
// unknown site actions are warnings, not errors, because a peer never gets
// the caller's site functions (spec section 1.1 / README linking notes).
// ---------------------------------------------------------------------------

export function classifyToolRef(ref, agentNames, linksForNetwork) {
  if (ref && typeof ref === 'object') {
    if (typeof ref.url === 'string' && ref.url) {
      return { kind: 'mcp', url: ref.url, tools: Array.isArray(ref.tools) ? ref.tools : null };
    }
    return { kind: 'invalid', reason: 'tool descriptor has no url' };
  }
  if (typeof ref !== 'string' || !ref) {
    return { kind: 'invalid', reason: 'tool reference must be a non-empty string or descriptor' };
  }
  if (ref.startsWith('https://') || ref.startsWith('http://')) {
    return { kind: 'peer', url: ref };
  }
  if (ref.startsWith('website_')) {
    return { kind: 'site-action', name: ref.slice('website_'.length) };
  }
  if (agentNames.has(ref)) return { kind: 'local', name: ref };
  if (linksForNetwork && typeof linksForNetwork[ref] === 'string') {
    return { kind: 'peer', url: linksForNetwork[ref], symbolic: ref };
  }
  return { kind: 'invalid', reason: `unknown agent, site action, or peer link: "${ref}"` };
}

export function validateNetwork(def, options = {}) {
  const errors = [];
  const warnings = [];
  const { frontMan, siteActions = new Map(), links = {}, networkName = '' } = options;
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return { ok: false, errors: ['network definition must be a JSON object'], warnings };
  }
  if (!Array.isArray(def.tools) || def.tools.length === 0) {
    return { ok: false, errors: ['network definition needs a non-empty "tools" array'], warnings };
  }
  const names = new Set();
  // First pass: collect every agent name and check each agent's own shape.
  for (const agent of def.tools) {
    if (!agent || typeof agent !== 'object') {
      errors.push('every entry in "tools" must be an agent object');
      continue;
    }
    if (typeof agent.name !== 'string' || !agent.name) {
      errors.push('every agent needs a non-empty string "name"');
      continue;
    }
    if (names.has(agent.name)) errors.push(`duplicate agent name: "${agent.name}"`);
    names.add(agent.name);
    if (!agent.function || typeof agent.function.description !== 'string') {
      errors.push(`agent "${agent.name}" needs function.description`);
    }
    if (agent.function && agent.function.parameters !== undefined) {
      const p = agent.function.parameters;
      if (!p || typeof p !== 'object' || p.type !== 'object') {
        errors.push(`agent "${agent.name}": function.parameters must be an object JSON Schema`);
      }
    }
    if (typeof agent.instructions !== 'string' || !agent.instructions.trim()) {
      errors.push(`agent "${agent.name}" needs non-empty "instructions"`);
    }
    if (!Array.isArray(agent.tools)) {
      errors.push(`agent "${agent.name}" needs a "tools" array (possibly empty)`);
    }
  }
  // Second pass: resolve every tool reference against the full name set.
  for (const agent of def.tools) {
    if (!agent || typeof agent !== 'object' || typeof agent.name !== 'string' || !Array.isArray(agent.tools)) {
      continue;
    }
    const linksForNetwork = (links.networks && links.networks[networkName]) || {};
    for (const ref of agent.tools) {
      const c = classifyToolRef(ref, names, linksForNetwork);
      if (c.kind === 'invalid') {
        errors.push(`agent "${agent.name}": ${c.reason}`);
      } else if (c.kind === 'site-action' && !siteActions.has(c.name)) {
        // Local networks must resolve their site actions; peer networks
        // get a warning and fail closed if they ever call one.
        if (options.strictSiteActions === false) {
          warnings.push(`agent "${agent.name}": site action "website_${c.name}" is not available here`);
        } else {
          errors.push(`agent "${agent.name}": unknown site action "website_${c.name}"`);
        }
      }
    }
  }
  if (frontMan && !names.has(frontMan)) {
    errors.push(`front agent "${frontMan}" is not defined in the network`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Fetch helpers.
// ---------------------------------------------------------------------------

export async function fetchJson(url, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new EngineError(`GET ${url} failed with HTTP ${res.status}`, 'fetch-failed');
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new EngineError(`GET ${url} did not return valid JSON`, 'invalid-json');
    }
  } catch (err) {
    if (err instanceof EngineError) throw err;
    if (err && err.name === 'AbortError') {
      throw new EngineError(`GET ${url} timed out after ${timeoutMs} ms`, 'fetch-timeout');
    }
    throw new EngineError(`Could not fetch ${url}: ${err.message || err}`, 'fetch-failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Parse an MCP response body that may be plain JSON or an SSE stream. */
function parseMcpBody(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new EngineError('MCP server returned an empty response', 'mcp-error');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // SSE stream: take the last data: line that parses as a JSON-RPC message.
  let last = null;
  for (const line of trimmed.split('\n')) {
    const m = line.match(/^data:\s*(.*)$/);
    if (m && m[1] !== '[DONE]') {
      try {
        const obj = JSON.parse(m[1]);
        if (obj && (obj.result !== undefined || obj.error)) last = obj;
      } catch { /* ignore non-JSON event lines */ }
    }
  }
  if (!last) throw new EngineError('MCP server returned no JSON-RPC response', 'mcp-error');
  return last;
}

// ---------------------------------------------------------------------------
// Minimal MCP client (streamable HTTP / JSON-RPC 2.0). Best effort: any
// failure is reported as an EngineError and the caller fails closed.
// ---------------------------------------------------------------------------

export class McpClient {
  constructor(url, { timeoutMs = 30000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      });
    } catch (err) {
      throw new EngineError(
        `MCP request to ${this.url} failed: ${err.message || err}`, 'mcp-error',
      );
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      throw new EngineError(`MCP server ${this.url} returned HTTP ${res.status}`, 'mcp-error');
    }
    let msg;
    try {
      msg = parseMcpBody(await res.text());
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(`MCP server ${this.url} returned an unreadable response`, 'mcp-error');
    }
    if (msg.error) {
      throw new EngineError(
        `MCP error from ${this.url}: ${msg.error.message || JSON.stringify(msg.error)}`,
        'mcp-error',
      );
    }
    return msg.result;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'evidence-desk', version: '1.0.0' },
    });
    // Best-effort initialized notification; ignore failures.
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch { /* notification is optional */ }
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return Array.isArray(result && result.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} });
    const parts = Array.isArray(result && result.content) ? result.content : [];
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
    if (result && result.isError) {
      throw new EngineError(`MCP tool "${name}" reported an error: ${text || '(no detail)'}`, 'mcp-error');
    }
    return text || JSON.stringify(result || {});
  }
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS = {
  maxStepsPerAgent: 12,
  maxLlmCalls: 60,
  maxDepth: 6,
  llmTimeoutMs: 120000,
  runTimeoutMs: 420000,
  maxToolResultChars: 8000,
};

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated to ${maxChars} characters]`;
}

function sanitizeToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

export class AgentEngine {
  /**
   * @param {object} opts
   * @param {object} opts.llm - client with chat({messages, tools, signal, onToken})
   *   returning { content, toolCalls: [{id, name, arguments}] }
   * @param {Array} opts.siteActions - [{name, description, parameters, effect, handler}]
   * @param {object} opts.links - links.json content for symbolic peer resolution
   * @param {object|null} opts.manifest - this site's agent-manifest.json (peer policy)
   * @param {function} opts.onEvent - ({type, ...}) => void
   * @param {function} opts.onConsent - async ({kind, origin, purpose, detail}) => boolean
   * @param {object} opts.limits - execution bounds (see DEFAULT_LIMITS)
   */
  constructor(opts = {}) {
    if (!opts.llm || typeof opts.llm.chat !== 'function') {
      throw new EngineError('AgentEngine needs an llm client with a chat() method', 'bad-llm-client');
    }
    this.llm = opts.llm;
    this.siteActions = new Map((opts.siteActions || []).map((a) => [a.name, a]));
    this.links = opts.links || {};
    this.manifest = opts.manifest || null;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.onConsent = typeof opts.onConsent === 'function' ? opts.onConsent : async () => false;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  }

  emit(type, detail = {}) {
    try {
      this.onEvent({ type, ...detail });
    } catch { /* event handlers must never break a run */ }
  }

  // -- Peer policy (spec section 3.2 + 5): the caller's manifest decides
  // which third-party origins may be contacted at all. Consent is separate
  // and is asked per contact. ----------------------------------------------
  peerOriginAllowed(origin) {
    if (!this.manifest) return true;
    const policy = this.manifest.peer_policy || {};
    if (policy.mode === 'open') return true;
    const allowed = new Set([
      ...(this.manifest.allowed_peers || []),
      ...(policy.allow_origins || []),
    ]);
    return allowed.has(origin);
  }

  async loadNetworkFromUrl(url) {
    const raw = await fetchJson(url);
    return resolveNetworkPlaceholders(raw);
  }

  /**
   * Load a peer network by its public URL, following the section 3.2
   * protocol: consent, manifest fetch, exact name match, definition fetch.
   * Results are cached per run in ctx.peerCache.
   */
  async loadPeerNetwork(peerUrl, ctx) {
    if (ctx.peerCache.has(peerUrl)) return ctx.peerCache.get(peerUrl);
    const { siteBase, networkName, origin } = splitPeerUrl(peerUrl);
    const parsed = new URL(peerUrl);
    const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLoopback) {
      throw new EngineError(
        `Refusing peer URL ${peerUrl}: peer networks must use HTTPS (spec section 3.2).`,
        'peer-not-https',
      );
    }
    if (!this.peerOriginAllowed(origin)) {
      throw new EngineError(
        `Refusing peer origin ${origin}: it is not in this site's peer allow-list.`,
        'peer-origin-not-allowed',
      );
    }
    const approved = await this.onConsent({
      kind: 'peer',
      origin,
      purpose: `Load the "${networkName}" agent network from ${origin} and run it in this browser, on your model. The peer site never receives your API key.`,
      detail: { peerUrl, networkName },
    });
    if (!approved) {
      throw new EngineError(
        `The visitor declined contact with ${origin}; the peer call did not run.`,
        'consent-denied',
      );
    }
    this.emit('peer_manifest_fetch', { peerUrl, siteBase, networkName });
    const manifest = await fetchJson(`${siteBase}agent-manifest.json`);
    const networks = Array.isArray(manifest.networks) ? manifest.networks : [];
    const entry = networks.find((n) => n && n.name === networkName);
    if (!entry) {
      throw new EngineError(
        `Peer manifest at ${siteBase}agent-manifest.json has no network named "${networkName}"; refusing to pick another one (spec section 3.2).`,
        'peer-network-not-found',
      );
    }
    if (!entry.front_man || !entry.hocon) {
      throw new EngineError(
        `Peer network "${networkName}" is missing front_man or hocon in its manifest.`,
        'peer-manifest-invalid',
      );
    }
    const defUrl = new URL(entry.hocon, siteBase).href;
    const raw = await fetchJson(defUrl);
    const def = resolveNetworkPlaceholders(raw);
    const check = validateNetwork(def, {
      frontMan: entry.front_man,
      siteActions: this.siteActions,
      links: this.links,
      networkName,
      strictSiteActions: false,
    });
    if (!check.ok) {
      throw new EngineError(
        `Peer network "${networkName}" failed validation: ${check.errors.join('; ')}`,
        'peer-network-invalid',
      );
    }
    for (const w of check.warnings || []) this.emit('peer_warning', { peerUrl, warning: w });
    const loaded = { def, frontMan: entry.front_man, networkName, siteBase, origin };
    ctx.peerCache.set(peerUrl, loaded);
    return loaded;
  }

  /**
   * Run a network's front agent.
   * @param {object|string} network - resolved definition object, or a URL to fetch
   * @param {object} opts - { frontMan, input, networkName }
   * @returns {Promise<{text: string, trace: Array}>}
   */
  async run(network, opts = {}) {
    const startedAt = Date.now();
    const ctx = {
      startedAt,
      llmCalls: 0,
      peerCache: new Map(),
      mcpCache: new Map(),
      trace: [],
    };
    const def = typeof network === 'string' ? await this.loadNetworkFromUrl(network) : network;
    const networkName = opts.networkName || '';
    const frontMan = opts.frontMan;
    const check = validateNetwork(def, {
      frontMan,
      siteActions: this.siteActions,
      links: this.links,
      networkName,
      strictSiteActions: true,
    });
    if (!check.ok) {
      throw new EngineError(`Network failed validation: ${check.errors.join('; ')}`, 'network-invalid');
    }
    this.emit('run_start', { networkName, frontMan });
    const scope = { def, networkName, origin: 'local', depth: 0 };
    const text = await this.invokeAgent(frontMan, opts.input || {}, ctx, scope);
    this.emit('run_end', { networkName, frontMan, llmCalls: ctx.llmCalls, elapsedMs: Date.now() - startedAt });
    return { text, trace: ctx.trace };
  }

  // -- Agent invocation -------------------------------------------------------

  agentDef(scope, name) {
    return scope.def.tools.find((a) => a && a.name === name) || null;
  }

  /**
   * Build the model-visible function schemas for one agent, resolving its
   * tool references. Returns { schemas, dispatch } where dispatch maps a
   * function name to how a call to it is executed.
   */
  async buildAgentTools(agent, ctx, scope) {
    const schemas = [];
    const dispatch = new Map();
    const agentNames = new Set(scope.def.tools.map((a) => a.name));
    const linksForNetwork = (this.links.networks && this.links.networks[scope.networkName]) || {};
    const usedNames = new Set();
    let unavailableNotes = [];

    const claimName = (preferred) => {
      let name = sanitizeToolName(preferred);
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
      let i = 2;
      while (usedNames.has(`${name}_${i}`)) i += 1;
      const unique = `${name}_${i}`;
      usedNames.add(unique);
      return unique;
    };

    for (const ref of agent.tools || []) {
      const c = classifyToolRef(ref, agentNames, linksForNetwork);
      if (c.kind === 'local') {
        const target = this.agentDef(scope, c.name);
        const fnName = claimName(target.name);
        schemas.push({
          type: 'function',
          function: {
            name: fnName,
            description: (target.function && target.function.description) || `Call agent ${target.name}.`,
            parameters: (target.function && target.function.parameters) || { type: 'object', properties: {} },
          },
        });
        dispatch.set(fnName, { kind: 'local', name: target.name });
      } else if (c.kind === 'peer') {
        const { networkName, origin } = splitPeerUrl(c.url);
        const fnName = claimName(networkName);
        schemas.push({
          type: 'function',
          function: {
            name: fnName,
            description:
              `Call the "${networkName}" agent network published by ${origin}. ` +
              'It runs in this browser on the visitor\'s own model; the peer site never receives the visitor\'s API key. ' +
              'The visitor is asked for approval before the call. Ask it for exactly one thing per call.',
            parameters: {
              type: 'object',
              properties: { request: { type: 'string', description: 'The request in plain language.' } },
              required: ['request'],
            },
          },
        });
        dispatch.set(fnName, { kind: 'peer', url: c.url, networkName, origin });
      } else if (c.kind === 'site-action') {
        const action = this.siteActions.get(c.name);
        if (!action) {
          unavailableNotes.push(`Site action "website_${c.name}" is not available in this browser; do not call it.`);
          continue;
        }
        const fnName = claimName(`website_${action.name}`);
        schemas.push({
          type: 'function',
          function: {
            name: fnName,
            description: action.description || `Run the site action ${action.name}.`,
            parameters: action.parameters || { type: 'object', properties: {} },
          },
        });
        dispatch.set(fnName, { kind: 'site-action', name: action.name });
      } else if (c.kind === 'mcp') {
        const tools = await this.discoverMcpTools(c, ctx, scope);
        if (tools.length === 0) {
          unavailableNotes.push(`The MCP server at ${c.url} could not be reached or listed no tools; do not call it.`);
          continue;
        }
        for (const t of tools) {
          const fnName = claimName(`mcp_${sanitizeToolName(new URL(c.url).hostname)}_${t.name}`);
          schemas.push({
            type: 'function',
            function: {
              name: fnName,
              description: t.description || `MCP tool ${t.name} on ${c.url}.`,
              parameters: t.inputSchema || { type: 'object', properties: {} },
            },
          });
          dispatch.set(fnName, { kind: 'mcp', url: c.url, tool: t.name });
        }
      }
      // classifyToolRef already validated every reference, so 'invalid'
      // cannot occur here.
    }
    return { schemas, dispatch, unavailableNotes };
  }

  /** Discover an MCP server's tools once per run (consent-gated). */
  async discoverMcpTools(descriptor, ctx, scope) {
    const key = descriptor.url;
    if (ctx.mcpCache.has(key)) return ctx.mcpCache.get(key);
    const origin = new URL(descriptor.url).origin;
    const approved = await this.onConsent({
      kind: 'mcp',
      origin,
      purpose: `Discover the tools offered by the MCP server at ${descriptor.url}.`,
      detail: { url: descriptor.url },
    });
    if (!approved) {
      this.emit('mcp_declined', { url: descriptor.url });
      ctx.mcpCache.set(key, []);
      return [];
    }
    try {
      const client = new McpClient(descriptor.url);
      await client.initialize();
      let tools = await client.listTools();
      if (Array.isArray(descriptor.tools)) {
        const allowed = new Set(descriptor.tools);
        tools = tools.filter((t) => allowed.has(t.name));
      }
      ctx.mcpCache.set(key, tools);
      ctx.mcpCache.set(`${key}#client`, client);
      return tools;
    } catch (err) {
      this.emit('mcp_error', { url: descriptor.url, error: err.message });
      ctx.mcpCache.set(key, []);
      return [];
    }
  }

  async invokeAgent(agentName, args, ctx, scope) {
    if (scope.depth > this.limits.maxDepth) {
      throw new EngineError(
        `Delegation depth limit (${this.limits.maxDepth}) exceeded at agent "${agentName}".`,
        'depth-exceeded',
      );
    }
    const agent = this.agentDef(scope, agentName);
    if (!agent) {
      throw new EngineError(`Agent "${agentName}" is not defined in this network.`, 'unknown-agent');
    }
    if (agent.function && agent.function.parameters) {
      const check = validateArgs(args || {}, agent.function.parameters);
      if (!check.ok) {
        throw new EngineError(
          `Invalid arguments for agent "${agentName}": ${check.errors.join('; ')}`,
          'invalid-arguments',
        );
      }
    }
    const label = scope.origin === 'local' ? agentName : `${scope.networkName}/${agentName}`;
    this.emit('agent_start', { agent: agentName, network: scope.networkName, origin: scope.origin, label });
    ctx.trace.push({ kind: 'agent_start', agent: agentName, network: scope.networkName, origin: scope.origin });

    const { schemas, dispatch, unavailableNotes } = await this.buildAgentTools(agent, ctx, scope);
    let system = agent.instructions;
    if (unavailableNotes.length) {
      system += `\n\nUNAVAILABLE CAPABILITIES (do not attempt these calls):\n- ${unavailableNotes.join('\n- ')}`;
    }
    const argKeys = Object.keys(args || {});
    const userContent =
      argKeys.length === 1 && argKeys[0] === 'request' && typeof args.request === 'string'
        ? args.request
        : JSON.stringify(args || {});
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ];
    const maxSteps = Number.isInteger(scope.def.max_steps) ? scope.def.max_steps : this.limits.maxStepsPerAgent;

    for (let step = 0; step < maxSteps; step += 1) {
      if (ctx.llmCalls >= this.limits.maxLlmCalls) {
        throw new EngineError(
          `Run budget exceeded: more than ${this.limits.maxLlmCalls} model calls.`,
          'budget-exceeded',
        );
      }
      if (Date.now() - ctx.startedAt > this.limits.runTimeoutMs) {
        throw new EngineError(
          `Run time limit (${Math.round(this.limits.runTimeoutMs / 1000)}s) exceeded.`,
          'timeout-exceeded',
        );
      }
      ctx.llmCalls += 1;
      this.emit('llm_start', { agent: agentName, network: scope.networkName, call: ctx.llmCalls });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.limits.llmTimeoutMs);
      let result;
      try {
        result = await this.llm.chat({
          messages,
          tools: schemas.length ? schemas : undefined,
          signal: controller.signal,
          onToken: (text) => this.emit('token', { agent: agentName, network: scope.networkName, text }),
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new EngineError(
            `Model call for agent "${agentName}" timed out after ${this.limits.llmTimeoutMs / 1000}s.`,
            'llm-timeout',
          );
        }
        throw new EngineError(
          `Model call for agent "${agentName}" failed: ${err.message || err}`,
          'llm-error',
        );
      } finally {
        clearTimeout(timer);
      }
      this.emit('llm_end', { agent: agentName, network: scope.networkName });
      const content = result.content || '';
      const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      messages.push({
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      });
      if (toolCalls.length === 0) {
        this.emit('agent_end', { agent: agentName, network: scope.networkName, origin: scope.origin, output: content });
        ctx.trace.push({ kind: 'agent_end', agent: agentName, network: scope.networkName, origin: scope.origin, output: content });
        return content;
      }
      for (const tc of toolCalls) {
        const outcome = await this.dispatchToolCall(tc, dispatch, ctx, scope);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: outcome });
      }
    }
    throw new EngineError(
      `Agent "${agentName}" did not finish within ${maxSteps} steps.`,
      'max-steps-exceeded',
    );
  }

  async dispatchToolCall(tc, dispatch, ctx, scope) {
    const entry = dispatch.get(tc.name);
    this.emit('tool_call', { name: tc.name, arguments: tc.arguments });
    ctx.trace.push({ kind: 'tool_call', name: tc.name, arguments: tc.arguments });
    let outcome;
    try {
      if (!entry) {
        throw new EngineError(
          `The model called "${tc.name}", which is not an available tool for this agent.`,
          'unknown-tool',
        );
      }
      let args;
      try {
        args = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        throw new EngineError(`Arguments for "${tc.name}" were not valid JSON.`, 'bad-tool-arguments');
      }
      if (entry.kind === 'local') {
        const target = this.agentDef(scope, entry.name);
        if (target && target.function && target.function.parameters) {
          const check = validateArgs(args, target.function.parameters);
          if (!check.ok) {
            throw new EngineError(
              `Invalid arguments for agent "${entry.name}": ${check.errors.join('; ')}`,
              'invalid-arguments',
            );
          }
        }
        outcome = await this.invokeAgent(entry.name, args, ctx, { ...scope, depth: scope.depth + 1 });
      } else if (entry.kind === 'peer') {
        const check = validateArgs(args, {
          type: 'object',
          properties: { request: { type: 'string' } },
          required: ['request'],
        });
        if (!check.ok) {
          throw new EngineError(`Invalid arguments for peer "${entry.networkName}": ${check.errors.join('; ')}`, 'invalid-arguments');
        }
        const peer = await this.loadPeerNetwork(entry.url, ctx);
        outcome = await this.invokeAgent(peer.frontMan, { request: args.request }, ctx, {
          def: peer.def,
          networkName: peer.networkName,
          origin: peer.origin,
          depth: scope.depth + 1,
        });
      } else if (entry.kind === 'site-action') {
        const action = this.siteActions.get(entry.name);
        if (!action) {
          throw new EngineError(`Site action "${entry.name}" is not registered.`, 'unknown-action');
        }
        if (action.parameters) {
          const check = validateArgs(args, action.parameters);
          if (!check.ok) {
            throw new EngineError(
              `Invalid arguments for site action "${entry.name}": ${check.errors.join('; ')}`,
              'invalid-arguments',
            );
          }
        }
        if (action.effect && action.effect !== 'read') {
          const approved = await this.onConsent({
            kind: 'site-action',
            origin: 'this site',
            purpose: `Run the site action "${action.name}" (${action.effect}) with arguments ${JSON.stringify(args)}.`,
            detail: { action: action.name, arguments: args },
          });
          if (!approved) {
            throw new EngineError(`The visitor declined the site action "${action.name}".`, 'consent-denied');
          }
        }
        const raw = await action.handler(args, { engine: this });
        outcome = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } else if (entry.kind === 'mcp') {
        const client = ctx.mcpCache.get(`${entry.url}#client`);
        if (!client) {
          throw new EngineError(`MCP client for ${entry.url} is not connected.`, 'mcp-error');
        }
        outcome = await client.callTool(entry.tool, args);
      } else {
        throw new EngineError(`Unknown tool dispatch kind for "${tc.name}".`, 'unknown-tool');
      }
    } catch (err) {
      // Fail closed per tool: report the failure to the model so it can
      // recover or report it, instead of pretending the call succeeded.
      // Budget and timeout failures are fatal to the whole run.
      if (err instanceof EngineError && (err.code === 'budget-exceeded' || err.code === 'timeout-exceeded' || err.code === 'depth-exceeded')) {
        throw err;
      }
      outcome = `Error from tool "${tc.name}": ${err.message || err}`;
    }
    const truncated = truncate(String(outcome), this.limits.maxToolResultChars);
    this.emit('tool_result', { name: tc.name, result: truncated });
    ctx.trace.push({ kind: 'tool_result', name: tc.name, result: truncated });
    return truncated;
  }
}
