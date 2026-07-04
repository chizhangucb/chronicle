import crypto from 'node:crypto';
import express from 'express';
import { listServices, servicesForRoot } from './registry.js';
import { connect, connectedStdio } from './upstream.js';

// Aggregating MCP server (FR-MCP-1/14): a Streamable-HTTP /mcp endpoint that
// namespaces upstream tools as <service>__<tool> and routes calls.

const hubState = globalThis.__chronicleHub ??= {
  sessions: new Map(),   // MCP-Session-Id -> {createdAt, clientInfo}
  log: [],               // inspector ring buffer (FR-MCP-11)
};

const SEP = '__';
const PROTOCOL_VERSION = '2025-03-26';

function logEntry(direction, payload, extra = {}) {
  hubState.log.push({ ts: new Date().toISOString(), direction, ...extra, payload });
  if (hubState.log.length > 300) hubState.log.splice(0, hubState.log.length - 300);
}

async function aggregateTools(root = null) {
  // FR-MCP-10: route by client root (longest-prefix-match); no root = globals only
  const services = servicesForRoot(root);
  const tools = [];
  const errors = {};
  await Promise.all(services.map(async (svc) => {
    try {
      const client = await connect(svc);
      const disabled = new Set(JSON.parse(svc.disabled_tools || '[]'));
      for (const t of client.tools) {
        if (disabled.has(t.name)) continue; // FR-MCP-9: policy-filtered
        tools.push({ ...t, name: `${svc.name}${SEP}${t.name}`, description: `[${svc.name}] ${t.description ?? ''}` });
      }
    } catch (err) {
      errors[svc.name] = String(err.message || err);
    }
  }));
  return { tools, errors };
}

export async function callTool(namespaced, args) {
  const idx = namespaced.indexOf(SEP);
  if (idx === -1) throw new Error(`Unknown tool '${namespaced}' (expected <service>${SEP}<tool>)`);
  const serviceName = namespaced.slice(0, idx);
  const toolName = namespaced.slice(idx + SEP.length);
  const svc = listServices().find((s) => s.name === serviceName);
  if (!svc) throw new Error(`Unknown service '${serviceName}'`);
  if (!svc.enabled) throw new Error(`Service '${serviceName}' is disabled by policy`);
  if (JSON.parse(svc.disabled_tools || '[]').includes(toolName)) {
    logEntry('blocked', { tool: namespaced });
    throw new Error(`Tool '${toolName}' on '${serviceName}' is blocked by tool policy`);
  }
  const client = await connect(svc);
  return client.request('tools/call', { name: toolName, arguments: args ?? {} });
}

export { aggregateTools };

export function hubStatus() {
  const services = listServices();
  return {
    endpoint: '/mcp',
    protocolVersion: PROTOCOL_VERSION,
    services: services.length,
    enabled: services.filter((s) => s.enabled).length,
    sessions: hubState.sessions.size,
    connectedStdio: connectedStdio(),
  };
}

export function hubLog() { return hubState.log.slice().reverse(); }

// ---- The /mcp endpoint (POST JSON-RPC; GET/DELETE per spec) ----

export const mcpEndpoint = express();
mcpEndpoint.use(express.json({ limit: '8mb' }));

// Origin validation (CSRF protection, FR-MCP-14): allow localhost + non-browser clients
mcpEndpoint.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});

mcpEndpoint.post('/', async (req, res) => {
  const msg = req.body;
  const sessionId = req.headers['mcp-session-id'];
  logEntry('recv', msg, { sessionId });

  const reply = (result) => {
    const payload = { jsonrpc: '2.0', id: msg.id, result };
    logEntry('send', payload, { sessionId });
    res.json(payload);
  };
  const fail = (code, message) => {
    const payload = { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } };
    logEntry('send', payload, { sessionId });
    res.status(200).json(payload);
  };

  try {
    if (Array.isArray(msg)) return fail(-32600, 'Batch requests not supported');
    if (msg?.method === 'initialize') {
      const sid = crypto.randomUUID();
      // Root discovery: explicit header, or rootUri/workspaceFolders from initialize
      const root = req.headers['x-chronicle-root']
        || msg.params?.rootUri?.replace('file://', '')
        || msg.params?.workspaceFolders?.[0]?.uri?.replace('file://', '')
        || null;
      hubState.sessions.set(sid, { createdAt: Date.now(), clientInfo: msg.params?.clientInfo, root });
      res.setHeader('MCP-Session-Id', sid);
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chronicle-mcp-hub', version: '0.1.0' },
      });
    }
    if (msg?.method?.startsWith('notifications/')) { logEntry('note', msg); return res.status(202).end(); }
    if (msg?.method === 'ping') return reply({});
    if (msg?.method === 'tools/list') {
      const root = req.headers['x-chronicle-root'] || hubState.sessions.get(sessionId)?.root || null;
      const { tools } = await aggregateTools(root);
      return reply({ tools });
    }
    if (msg?.method === 'tools/call') {
      const result = await callTool(msg.params?.name, msg.params?.arguments);
      return reply(result);
    }
    return fail(-32601, `Method not supported: ${msg?.method}`);
  } catch (err) {
    return fail(-32000, String(err.message || err));
  }
});

// GET (SSE stream) not offered — clients fall back to POST-only mode.
mcpEndpoint.get('/', (req, res) => res.status(405).set('Allow', 'POST, DELETE').end());
mcpEndpoint.delete('/', (req, res) => {
  const sid = req.headers['mcp-session-id'];
  if (sid) hubState.sessions.delete(sid);
  res.status(204).end();
});
