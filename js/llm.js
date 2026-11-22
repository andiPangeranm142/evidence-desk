/**
 * LLM clients for Evidence Desk.
 *
 * - OpenAICompatibleClient: any OpenAI-compatible chat-completions endpoint
 *   (OpenRouter, Mozilla Otari, or a custom router). The API key is supplied
 *   by the visitor, lives only in this client instance, and is sent only to
 *   the configured router. It is never logged, never placed in a URL, and
 *   never sent to a peer site.
 * - WebLLMClient (experimental): runs a small model on-device in the
 *   visitor's browser via WebGPU. No key needed. Requires a browser with
 *   WebGPU and downloads roughly 1 GB of model weights on first use.
 *
 * Both implement chat({ messages, tools, signal, onToken }) returning
 * { content, toolCalls: [{ id, name, arguments }] }.
 */

import { EngineError } from './engine.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

export class OpenAICompatibleClient {
  constructor({ baseUrl, apiKey, model, extraHeaders = {} }) {
    if (!baseUrl) throw new EngineError('LLM router base URL is missing.', 'llm-config');
    if (!model) throw new EngineError('LLM model is missing.', 'llm-config');
    this.baseUrl = baseUrl;
    this.apiKey = apiKey || '';
    this.model = model;
    this.extraHeaders = extraHeaders;
  }

  get label() {
    try {
      return `${new URL(this.baseUrl).hostname} / ${this.model}`;
    } catch {
      return this.model;
    }
  }

  async chat({ messages, tools, signal, onToken }) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let res;
    try {
      res = await fetch(joinUrl(this.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools && tools.length ? tools : undefined,
          tool_choice: tools && tools.length ? 'auto' : undefined,
          stream: true,
          temperature: 0.2,
        }),
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new EngineError(
        `Could not reach the LLM router at ${this.baseUrl}. Check the router URL and your connection. (${err.message || err})`,
        'llm-unreachable',
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        detail = (parsed.error && (parsed.error.message || parsed.error.code)) || body.slice(0, 300);
      } catch {
        detail = `HTTP ${res.status}`;
      }
      if (res.status === 401 || res.status === 403) {
        throw new EngineError(
          `The router rejected the request (HTTP ${res.status}). Check the API key in Model settings. ${detail}`,
          'llm-auth',
        );
      }
      if (res.status === 404) {
        throw new EngineError(
          `The router returned 404. Check the router base URL and model name in Model settings. ${detail}`,
          'llm-not-found',
        );
      }
      if (res.status === 429) {
        throw new EngineError(
          `The router rate-limited the request (HTTP 429). Wait a moment and try again. ${detail}`,
          'llm-rate-limit',
        );
      }
      throw new EngineError(`LLM router error (HTTP ${res.status}): ${detail}`, 'llm-error');
    }
    return readChatStream(res, onToken);
  }
}

/** Read an OpenAI-style SSE chat stream, accumulating text and tool calls. */
async function readChatStream(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = new Map(); // index -> { id, name, arguments }

  const handleData = (data) => {
    if (data === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return; // ignore non-JSON SSE lines
    }
    const choice = obj && obj.choices && obj.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (onToken) onToken(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const prev = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
        if (tc.id) prev.id = tc.id;
        if (tc.function) {
          if (tc.function.name) prev.name += tc.function.name;
          if (tc.function.arguments) prev.arguments += tc.function.arguments;
        }
        toolCalls.set(idx, prev);
      }
    }
    // Non-streaming-shaped payloads (some routers ignore stream=true).
    if (choice.message) {
      const msg = choice.message;
      if (typeof msg.content === 'string' && msg.content) {
        content += msg.content;
        if (onToken) onToken(msg.content);
      }
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc, i) => {
          toolCalls.set(i, {
            id: tc.id || `call_${i}`,
            name: (tc.function && tc.function.name) || '',
            arguments: (tc.function && tc.function.arguments) || '',
          });
        });
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) handleData(line.slice(5).trim());
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim());
  }

  const calls = [...toolCalls.values()]
    .filter((tc) => tc.name)
    .map((tc, i) => ({ id: tc.id || `call_${i}`, name: tc.name, arguments: tc.arguments || '{}' }));
  return { content, toolCalls: calls };
}

// ---------------------------------------------------------------------------
// WebLLM (experimental, on-device). Loaded lazily from a CDN only when the
// visitor explicitly enables it; never loaded otherwise.
// ---------------------------------------------------------------------------

const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm@0.2.79';
export const WEBLLM_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

export class WebLLMClient {
  constructor({ model = WEBLLM_MODEL, onProgress } = {}) {
    this.model = model;
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.engine = null;
    this.initPromise = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  get label() {
    return `on-device (WebLLM) / ${this.model}`;
  }

  async init() {
    if (this.engine) return this.engine;
    if (this.initPromise) return this.initPromise;
    if (!WebLLMClient.isSupported()) {
      throw new EngineError(
        'On-device inference needs WebGPU, which this browser does not expose. Use a BYOK router instead.',
        'webllm-unsupported',
      );
    }
    this.initPromise = (async () => {
      let mod;
      try {
        mod = await import(/* webpackIgnore: true */ WEBLLM_CDN);
      } catch (err) {
        throw new EngineError(
          `Could not load the on-device engine from the CDN. Check your connection and try again. (${err.message || err})`,
          'webllm-load-failed',
        );
      }
      const engine = await mod.CreateMLCEngine(this.model, {
        initProgressCallback: (report) => this.onProgress(report),
      });
      this.engine = engine;
      return engine;
    })();
    return this.initPromise;
  }

  async chat({ messages, tools, signal, onToken }) {
    const engine = await this.init();
    if (signal && signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const stream = await engine.chat.completions.create({
      messages,
      tools: tools && tools.length ? tools : undefined,
      stream: true,
      temperature: 0.2,
    });
    let content = '';
    const toolCalls = new Map();
    for await (const chunk of stream) {
      if (signal && signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const prev = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
          if (tc.id) prev.id = tc.id;
          if (tc.function) {
            if (tc.function.name) prev.name += tc.function.name;
            if (tc.function.arguments) prev.arguments += tc.function.arguments;
          }
          toolCalls.set(idx, prev);
        }
      }
    }
    const calls = [...toolCalls.values()]
      .filter((tc) => tc.name)
      .map((tc, i) => ({ id: tc.id || `call_${i}`, name: tc.name, arguments: tc.arguments || '{}' }));
    return { content, toolCalls: calls };
  }
}
