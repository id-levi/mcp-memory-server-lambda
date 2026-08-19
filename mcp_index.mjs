// hksoka-mcp — read-only MCP server exposing HKSoka memory to claude.ai custom connectors.
// Design locks: D1 new Lambda / D2 secret-URL loud-by-design / D3 three tools admin-scope
//               D4 loud truncation + paging / D5 resolveUser() leaves room for multi-user later.
// Transport: MCP Streamable HTTP, stateless, plain application/json responses.
// Supported protocol versions negotiated in initialize.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const FALLBACK_VERSION = '2025-11-25';

// D5: v1 single-user. Future multi-user = replace this with token -> user lookup.
function resolveUser() {
  return process.env.MCP_USER_ID;
}

async function getEmbedding(text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: 1536 }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.embedding?.values) {
    throw new Error(`Gemini embed failed: HTTP ${res.status} ${JSON.stringify(data.error ?? {}).slice(0, 200)}`);
  }
  return data.embedding.values;
}

const TOOLS = [
  {
    name: 'memory_search',
    description:
      "Semantic search over the user's HKSoka long-term memory: learned facts (auto-extracted from past HKSoka conversations) and seed documents (LTM doc, CV, project handover notes). Use whenever the user references past HKSoka work, decisions, bugs, handovers, or personal context that this conversation does not already contain. Cantonese/English mixed queries work.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query, same language as the stored content works best.' },
        top_k: { type: 'integer', description: 'Max results per pool (seed pool + learned pool). Default 10, max 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'seed_list',
    description:
      'List the HKSoka seed memory documents (name, total_chars, active flag). Call this first to learn what documents exist and how big each is, then use seed_get to read one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'seed_get',
    description:
      'Fetch raw text of one HKSoka seed document by exact name, with offset paging. Response always states total_chars, truncated and next_offset — when truncated is true, call again with offset = next_offset to keep reading. Nothing is silently cut.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact seed name as returned by seed_list.' },
        offset: { type: 'integer', description: 'Character offset to start from. Default 0.' },
        max_chars: { type: 'integer', description: 'Max characters to return this call. Default 8000, max 20000.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'conversation_search',
    description:
      "Case-insensitive keyword search over the user's HKSoka platform chat transcripts. Returns conversation id, name, updated_at and a raw-JSON snippet around the first match. Best for exact terms (error messages, file names, feature names); for vague concepts use memory_search instead. Conversations the user deleted (concealed) are excluded by design.",
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Exact keyword or phrase to match.' },
        limit: { type: 'integer', description: 'Max conversations to return. Default 5, max 10.' },
      },
      required: ['keyword'],
    },
  },
];

async function runTool(name, args) {
  const uid = resolveUser();
  if (!uid) throw new Error('MCP_USER_ID env var missing on server');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL env var missing on server');

  if (name === 'memory_search') {
    const query = String(args?.query ?? '').trim();
    if (!query) throw new Error('query is required');
    const topK = Math.min(Math.max(parseInt(args?.top_k ?? 10, 10) || 10, 1), 20);
    const embedding = await getEmbedding(query);
    // Same retrieval pattern as production chat.ts: hybrid RPC, two pools, per-pool quota.
    const [seedChunks, learnedChunks] = await Promise.all([
      sql`SELECT content, category, seed_id, seed_name FROM match_memory_chunks_hybrid(${JSON.stringify(embedding)}::vector, ${query}, ${uid}, 40) WHERE seed_id IS NOT NULL LIMIT ${topK}`,
      sql`SELECT content, category, seed_id, seed_name FROM match_memory_chunks_hybrid(${JSON.stringify(embedding)}::vector, ${query}, ${uid}, 40) WHERE seed_id IS NULL LIMIT ${topK}`,
    ]);
    return {
      query,
      counts: { seed: seedChunks.length, learned: learnedChunks.length },
      seed_results: seedChunks.map((c) => ({ source: c.seed_name ?? 'seed', content: c.content })),
      learned_results: learnedChunks.map((c) => ({ category: c.category, content: c.content })),
      note:
        seedChunks.length + learnedChunks.length === 0
          ? 'Zero matches. Try different wording, or conversation_search for exact terms.'
          : undefined,
    };
  }

  if (name === 'seed_list') {
    const rows = await sql`SELECT name, is_active, is_auto, length(content) AS total_chars, created_at FROM memory_seeds WHERE user_id = ${uid} ORDER BY created_at ASC`;
    return { count: rows.length, seeds: rows };
  }

  if (name === 'seed_get') {
    const seedName = String(args?.name ?? '').trim();
    if (!seedName) throw new Error('name is required');
    const offset = Math.max(parseInt(args?.offset ?? 0, 10) || 0, 0);
    const maxChars = Math.min(Math.max(parseInt(args?.max_chars ?? 8000, 10) || 8000, 200), 20000);
    const rows = await sql`SELECT content FROM memory_seeds WHERE user_id = ${uid} AND name = ${seedName} LIMIT 1`;
    if (rows.length === 0) {
      const names = await sql`SELECT name FROM memory_seeds WHERE user_id = ${uid} ORDER BY created_at ASC`;
      throw new Error(`Seed "${seedName}" missing. Existing names: ${names.map((r) => r.name).join(' | ')}`);
    }
    const full = rows[0].content ?? '';
    const slice = full.slice(offset, offset + maxChars);
    const end = offset + slice.length;
    // D4: loud truncation — total/offset/truncated/next_offset always present.
    return {
      name: seedName,
      total_chars: full.length,
      offset,
      returned_chars: slice.length,
      truncated: end < full.length,
      next_offset: end < full.length ? end : null,
      content: slice,
    };
  }

  if (name === 'conversation_search') {
    const keyword = String(args?.keyword ?? '').trim();
    if (!keyword) throw new Error('keyword is required');
    const limit = Math.min(Math.max(parseInt(args?.limit ?? 5, 10) || 5, 1), 10);
    const pattern = '%' + keyword.replace(/[%_\\]/g, (ch) => '\\' + ch) + '%';
    const rows = await sql`
      SELECT id, name, updated_at,
        substr(messages::text, GREATEST(POSITION(LOWER(${keyword}) IN LOWER(messages::text)) - 100, 1), 300) AS snippet
      FROM conversations
      WHERE user_id = ${uid}
        AND (concealed = false OR concealed IS NULL)
        AND messages::text ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT ${limit}`;
    return {
      keyword,
      count: rows.length,
      results: rows.map((r) => ({ conversation_id: r.id, name: r.name, updated_at: r.updated_at, snippet: r.snippet })),
      note: rows.length === 0 ? 'Zero matches for this exact keyword (concealed conversations excluded by design).' : undefined,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';
  const ip = event.requestContext?.http?.sourceIp ?? 'unknown';

  // D2 auth: exact secret path. Fail -> loud log (IP only, never the attempted path) + 404.
  if (!process.env.MCP_TOKEN || path !== `/mcp/${process.env.MCP_TOKEN}`) {
    console.error(`[MCP] auth_fail ip:${ip} method:${method} path_len:${path.length}`);
    return { statusCode: 404, body: 'Not found' };
  }

  // Stateless server: POST only. GET (server-initiated SSE) and DELETE (session end) unsupported.
  if (method !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: 'Method not allowed' };
  }

  let msg;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    msg = JSON.parse(raw);
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(msg)) {
    return json(400, rpcError(null, -32600, 'Batching unsupported (removed in spec 2025-06-18)'));
  }

  const { id, method: rpcMethod, params } = msg;

  // Notifications carry no id -> acknowledge, no body.
  if (id === undefined || id === null) {
    console.log(`[MCP] notification:${rpcMethod ?? 'unknown'}`);
    return { statusCode: 202, body: '' };
  }

  try {
    if (rpcMethod === 'initialize') {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : FALLBACK_VERSION;
      console.log(`[MCP] initialize client:${params?.clientInfo?.name ?? 'unknown'} requested:${requested} using:${version}`);
      return json(200, rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'hksoka-memory', version: '1.0.0' },
      }));
    }

    if (rpcMethod === 'ping') return json(200, rpcResult(id, {}));

    if (rpcMethod === 'tools/list') return json(200, rpcResult(id, { tools: TOOLS }));

    if (rpcMethod === 'tools/call') {
      const toolName = params?.name;
      const argsPreview = JSON.stringify(params?.arguments ?? {}).slice(0, 40);
      console.log(`[MCP] tool:${toolName} args_preview:${argsPreview}`);
      try {
        const result = await runTool(toolName, params?.arguments ?? {});
        const text = JSON.stringify(result, null, 2);
        console.log(`[MCP] tool:${toolName} ok result_chars:${text.length}`);
        return json(200, rpcResult(id, { content: [{ type: 'text', text }], isError: false }));
      } catch (err) {
        // Loud tool failure: Claude sees the reason, CloudWatch records it.
        console.error(`[MCP] tool:${toolName} error:${err.message}`);
        return json(200, rpcResult(id, { content: [{ type: 'text', text: `Tool error: ${err.message}` }], isError: true }));
      }
    }

    return json(200, rpcError(id, -32601, `Method unsupported: ${rpcMethod}`));
  } catch (err) {
    console.error(`[MCP] handler error:${err.message}`);
    return json(200, rpcError(id, -32603, 'Internal error'));
  }
};
