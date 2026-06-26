// Loadsensing → Supabase poller (Cloudflare Worker).
//
// Phase 1 (this file): fetch + parse Loadsensing CSV and expose a small
// debug HTTP API so we can verify the parser against the live gateway
// without writing to the database yet. The /run endpoint runs every
// node once and returns per-node row counts; /preview/{nodeId} returns
// the first ~20 parsed records for one node so we can eyeball them.
//
// Phase 2 (next): turn the cron handler into a real ETL — upsert
// devices + sensors and stream readings into monitoring.* via Supabase
// service role. The parser stays the same.

const GATEWAY_ID = 27808;
const BASE = 'https://loadsensing.wocs1.com';

const NODES = [
  { id: '108052', kind: 'inclinometer', endpoint: 'generic-modbus', label: 'INC-108052' },
  { id: '108102', kind: 'inclinometer', endpoint: 'generic-modbus', label: 'INC-108102' },
  { id: '108164', kind: 'inclinometer', endpoint: 'generic-modbus', label: 'INC-108164' },
  { id: '108403', kind: 'inclinometer', endpoint: 'generic-modbus', label: 'INC-108403' },
  { id: '181348', kind: 'piezometer',   endpoint: 'vw',             label: 'VWP-181348' },
  { id: '181361', kind: 'piezometer',   endpoint: 'vw',             label: 'VWP-181361' },
  { id: '181404', kind: 'piezometer',   endpoint: 'vw',             label: 'VWP-181404' },
  { id: '181456', kind: 'piezometer',   endpoint: 'vw',             label: 'VWP-181456' },
  { id: '181461', kind: 'piezometer',   endpoint: 'vw',             label: 'VWP-181461' },
];

function readingsPath(node) {
  if (node.endpoint === 'generic-modbus')
    return `/${GATEWAY_ID}/dataserver/current/reading/${node.id}/generic-modbus/${node.id}-6-readings-current.csv`;
  if (node.endpoint === 'vw')
    return `/${GATEWAY_ID}/dataserver/current/reading/${node.id}/vw/${node.id}-readings-current.csv`;
  throw new Error('unknown endpoint: ' + node.endpoint);
}

function healthPath(node) {
  return `/${GATEWAY_ID}/dataserver/current/health/${node.id}/health-${node.id}-current.csv`;
}

async function fetchCsv(path, auth) {
  const r = await fetch(BASE + path, { headers: { Authorization: auth } });
  if (!r.ok) return { ok: false, status: r.status, text: null };
  return { ok: true, status: 200, text: await r.text() };
}

// Loadsensing dumps lots of leading metadata rows ("Node ID,108052", etc),
// then a column header row starting with "Date-and-time", then data.
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    const first = (splitCsvLine(lines[i])[0] || '').trim().toLowerCase();
    if (first.startsWith('date-and-time') || first === 'date and time') { hi = i; break; }
  }
  if (hi < 0) return { error: 'no Date-and-time header row found' };

  const meta = {};
  for (let i = 0; i < hi; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length >= 2 && cells[0]) meta[cells[0].trim()] = (cells[1] || '').trim();
  }
  const tz = meta['Timezone'] || 'Asia/Makassar';

  const columns = splitCsvLine(lines[hi]).map(c => c.trim());
  const readings = [];
  let rowCount = 0;
  let skipped = 0;
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    rowCount++;
    const cells = splitCsvLine(lines[i]);
    const ts = parseTs(cells[0], tz);
    if (!ts) { skipped++; continue; }
    for (let j = 1; j < columns.length && j < cells.length; j++) {
      const raw = (cells[j] || '').trim();
      if (raw === '' || raw === '-' || raw === 'NaN') continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      readings.push({ ts, channel: columns[j], value: v });
    }
  }

  return { meta, columns, dataRowCount: rowCount, skippedRows: skipped, readings };
}

function splitCsvLine(line) {
  // Minimal split: handles double-quoted values with embedded commas.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseTs(s, tz) {
  // Loadsensing format observed: "M/D/YYYY h:mm" e.g. "6/2/2026 16:59".
  // Treat as wall-clock in the configured timezone and convert to UTC.
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, mo, d, y, h, mi, se] = m;
  // Asia/Makassar = UTC+8 fixed (no DST)
  const offsetH = tz === 'Asia/Makassar' ? 8 : 0;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h - offsetH, +mi, +(se || 0));
  return new Date(utcMs).toISOString();
}

function readingsToChannels(rows) {
  // Group flat [{ts, channel, value}, ...] → [{name, readings:[{ts,value}]}, ...]
  const byCh = new Map();
  for (const r of rows) {
    let arr = byCh.get(r.channel);
    if (!arr) { arr = []; byCh.set(r.channel, arr); }
    arr.push({ ts: r.ts, value: r.value });
  }
  const channels = [];
  for (const [name, readings] of byCh) channels.push({ name, readings });
  return channels;
}

async function callSupabaseRpc(env, body) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SR_KEY) {
    return { ok: false, error: 'SUPABASE_URL / SUPABASE_SR_KEY not configured' };
  }
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/ingest_loadsensing_payload', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SR_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SR_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_payload: body }),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, body: text };
  try { return { ok: true, result: JSON.parse(text) }; }
  catch { return { ok: true, result: text }; }
}

async function processNode(node, auth, mode, env) {
  const path = readingsPath(node);
  const { ok, status, text } = await fetchCsv(path, auth);
  if (!ok) return { node: node.id, label: node.label, kind: node.kind, ok: false, status };
  const parsed = parseCsv(text);
  if (parsed.error) return { node: node.id, label: node.label, kind: node.kind, ok: false, error: parsed.error };

  const out = {
    node: node.id,
    label: node.label,
    kind: node.kind,
    ok: true,
    csvBytes: text.length,
    dataRows: parsed.dataRowCount,
    skippedRows: parsed.skippedRows,
    columns: parsed.columns,
    meta: parsed.meta,
    readingsParsed: parsed.readings.length,
  };
  if (mode === 'preview') out.sample = parsed.readings.slice(0, 20);

  if (mode === 'ingest') {
    const payload = {
      node_id: node.id,
      kind: node.kind,
      label: node.label,
      category: node.kind, // matches monitoring.device_category enum we extended
      meta: parsed.meta,
      csv_bytes: text.length,
      channels: readingsToChannels(parsed.readings),
    };
    const rpc = await callSupabaseRpc(env, payload);
    out.ingest = rpc;
  }
  return out;
}

async function runAll(env, mode) {
  const auth = 'Basic ' + btoa(`${env.LS_USER}:${env.LS_PASS}`);
  const t0 = Date.now();
  const results = [];
  for (const node of NODES) {
    try { results.push(await processNode(node, auth, mode, env)); }
    catch (e) { results.push({ node: node.id, label: node.label, ok: false, error: e.message }); }
  }
  return { took_ms: Date.now() - t0, count: results.length, results };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  // Cron-triggered: fetch every node and ingest into Supabase via RPC.
  async scheduled(event, env, ctx) {
    const summary = await runAll(env, 'ingest');
    console.log('[scheduled]', JSON.stringify(summary));
  },

  // HTTP debug API:
  //   GET /                → list endpoints
  //   GET /run             → fetch every node, return parse stats (no DB write)
  //   GET /preview/{id}    → fetch one node, return first 20 parsed readings
  //   GET /raw/{id}        → return the raw CSV text for one node
  //   GET /ingest          → fetch every node AND push to Supabase (idempotent)
  //   GET /ingest/{id}     → ingest one node only
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '') {
      return json({
        endpoints: {
          'GET /run': 'fetch every node, return parse stats (no DB write)',
          'GET /preview/{nodeId}': 'fetch one node, return first 20 parsed readings',
          'GET /raw/{nodeId}': 'return raw CSV',
          'GET /ingest': 'fetch every node AND push to Supabase (idempotent)',
          'GET /ingest/{nodeId}': 'ingest one node only',
        },
        nodes: NODES.map(n => n.id),
        configured: { supabase: !!(env.SUPABASE_URL && env.SUPABASE_SR_KEY) },
      });
    }

    if (path === '/run')    return json(await runAll(env, 'summary'));
    if (path === '/ingest') return json(await runAll(env, 'ingest'));

    const prev = path.match(/^\/preview\/(\d+)$/);
    if (prev) {
      const node = NODES.find(n => n.id === prev[1]);
      if (!node) return json({ error: 'unknown node id' }, 404);
      const auth = 'Basic ' + btoa(`${env.LS_USER}:${env.LS_PASS}`);
      return json(await processNode(node, auth, 'preview', env));
    }

    const ing = path.match(/^\/ingest\/(\d+)$/);
    if (ing) {
      const node = NODES.find(n => n.id === ing[1]);
      if (!node) return json({ error: 'unknown node id' }, 404);
      const auth = 'Basic ' + btoa(`${env.LS_USER}:${env.LS_PASS}`);
      return json(await processNode(node, auth, 'ingest', env));
    }

    const raw = path.match(/^\/raw\/(\d+)$/);
    if (raw) {
      const node = NODES.find(n => n.id === raw[1]);
      if (!node) return new Response('unknown node id', { status: 404 });
      const auth = 'Basic ' + btoa(`${env.LS_USER}:${env.LS_PASS}`);
      const r = await fetchCsv(readingsPath(node), auth);
      if (!r.ok) return new Response('upstream ' + r.status, { status: 502 });
      return new Response(r.text, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  },
};
