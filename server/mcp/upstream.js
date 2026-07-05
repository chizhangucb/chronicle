import { spawn } from 'node:child_process';

// Upstream MCP clients. State lives on globalThis so Vite SSR module reloads
// don't orphan child processes or lose sessions.
const state = globalThis.__chronicleUpstreams ??= { stdio: new Map(), nextId: 1 };

const PROTOCOL_VERSION = '2025-03-26';

// ---- stdio transport: newline-delimited JSON-RPC over child stdin/stdout ----

class StdioClient {
  constructor(service) {
    this.service = service;
    this.pending = new Map();
    this.buffer = '';
    this.ready = null;
    this.tools = [];
    const args = JSON.parse(service.args || '[]');
    const env = { ...process.env, ...JSON.parse(service.env || '{}') };
    this.child = spawn(service.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const [, p] of this.pending) p.reject(new Error(`upstream '${service.name}' exited (${code})`));
      this.pending.clear();
      state.stdio.delete(service.name);
    });
  }

  onData(d) {
    this.buffer += d.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message || 'upstream error')) : p.resolve(msg.result);
        }
      } catch { /* non-JSON output line — ignore */ }
    }
  }

  request(method, params, timeoutMs = 20000) {
    const id = state.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} from '${this.service.name}'`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async init() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chronicle-mcp-hub', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    this.serverInfo = result?.serverInfo;
    const tools = await this.request('tools/list', {});
    this.tools = tools?.tools ?? [];
    return this;
  }

  stop() { try { this.child.kill(); } catch {} }
}

// ---- HTTP transport (Streamable HTTP upstream, JSON response mode) ----

class HttpClient {
  constructor(service) {
    this.service = service;
    this.tools = [];
    this.sessionId = null;
  }

  async request(method, params) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...JSON.parse(this.service.headers || '{}'),
    };
    if (this.sessionId) headers['MCP-Session-Id'] = this.sessionId;
    const res = await fetch(this.service.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: state.nextId++, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const ctype = res.headers.get('content-type') || '';
    let msg;
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      const dataLine = text.split('\n').reverse().find((l) => l.startsWith('data:'));
      msg = JSON.parse(dataLine.slice(5));
    } else {
      msg = await res.json();
    }
    if (msg.error) throw new Error(msg.error.message || 'upstream error');
    return msg.result;
  }

  async init() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chronicle-mcp-hub', version: '0.1.0' },
    });
    this.serverInfo = result?.serverInfo;
    try {
      await fetch(this.service.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...JSON.parse(this.service.headers || '{}'),
          ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch {}
    const tools = await this.request('tools/list', {});
    this.tools = tools?.tools ?? [];
    return this;
  }

  stop() {}
}

// ---- Connection manager ----

export async function connect(service) {
  if (service.transport === 'stdio') {
    const cached = state.stdio.get(service.name);
    if (cached && !cached.exited) return cached;
    const client = new StdioClient(service);
    state.stdio.set(service.name, client);
    try {
      await client.init();
    } catch (err) {
      client.stop();
      state.stdio.delete(service.name);
      throw err;
    }
    return client;
  }
  // http/sse upstreams are cheap to (re)initialize per hub session
  const client = new HttpClient(service);
  await client.init();
  return client;
}

export function connectedStdio() {
  return [...state.stdio.entries()].map(([name, c]) => ({
    name, pid: c.child.pid, tools: c.tools.length, serverInfo: c.serverInfo ?? null,
  }));
}

export function disconnect(name) {
  const c = state.stdio.get(name);
  if (c) { c.stop(); state.stdio.delete(name); }
}
