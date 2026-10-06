import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './src/engine/analyze.js';
import { loadTicker } from './src/data/load.js';
import { addPrints, getPrints, startPolling } from './src/data/flowStore.js';

const PORT = Number(process.env.PORT ?? 3000);
const DEMO = process.env.DATA_SOURCE === 'demo';
const FLOW_TOKEN = process.env.FLOW_TOKEN;
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 5_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || 'null');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/analyze') {
      const ticker = (url.searchParams.get('ticker') ?? '').trim().toUpperCase();
      if (!/^[A-Z.^-]{1,10}$/.test(ticker)) return send(res, 400, { error: 'Enter a valid ticker.' });
      const demo = DEMO || url.searchParams.get('demo') === '1';
      const data = await loadTicker(ticker, { demo });
      return send(res, 200, { ...analyze(data), sources: data.sources });
    }

    if (url.pathname === '/api/flow' && req.method === 'POST') {
      if (FLOW_TOKEN && req.headers.authorization !== `Bearer ${FLOW_TOKEN}`) return send(res, 401, { error: 'Unauthorized' });
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : [body];
      addPrints(list);
      return send(res, 200, { accepted: list.length });
    }

    if (url.pathname === '/api/flow') {
      const ticker = url.searchParams.get('ticker')?.toUpperCase();
      const prints = getPrints() ?? [];
      return send(res, 200, { connected: getPrints() !== null, prints: (ticker ? prints.filter((p) => p.ticker === ticker) : prints).slice(-200) });
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 404, { error: 'Not found' });
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    send(res, 502, { error: e.message });
  }
});

if (process.env.FLOW_FEED_URL) startPolling(process.env.FLOW_FEED_URL);

server.listen(PORT, () => {
  console.log(`strikeprice on http://localhost:${PORT}${DEMO ? ' (demo data)' : ''}`);
});
