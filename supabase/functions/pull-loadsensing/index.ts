// pull-loadsensing — Supabase Edge Function.
//
// Polls the on-prem Worldsensing Loadsensing gateway over HTTP, parses
// the wide CSV format (~300 columns per row), and pushes every non-empty
// numeric cell to public.ingest_loadsensing_payload — which upserts
// monitoring.devices, monitoring.sensors, and only inserts readings whose
// (sensor_id, ts) doesn't already exist.
//
// Scheduling: pg_cron job 'pull-loadsensing-hourly' invokes this every 1
// hour via net.http_post (see migrations). New readings trigger Supabase
// Realtime events so the monitoring dashboard updates live.
//
// Auth: Loadsensing basic auth credentials are embedded — they are HTTP
// basic for the on-prem gateway and live only inside this private
// Supabase project. The Supabase service role key is read from the
// SUPABASE_SERVICE_ROLE_KEY env var Supabase injects automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GATEWAY_ID = 27808;
const LS_BASE = "https://loadsensing.wocs3.com";
const LS_USER = "admin";
const LS_PASS = "quoh7say4";

type NodeDef = {
  id: string;
  kind: "inclinometer" | "piezometer";
  endpoint: "generic-modbus" | "vw";
  label: string;
};

const NODES: NodeDef[] = [
  { id: "108052", kind: "inclinometer", endpoint: "generic-modbus", label: "INC-108052" },
  { id: "108102", kind: "inclinometer", endpoint: "generic-modbus", label: "INC-108102" },
  { id: "108164", kind: "inclinometer", endpoint: "generic-modbus", label: "INC-108164" },
  { id: "108403", kind: "inclinometer", endpoint: "generic-modbus", label: "INC-108403" },
  { id: "181348", kind: "piezometer",   endpoint: "vw",             label: "VWP-181348" },
  { id: "181361", kind: "piezometer",   endpoint: "vw",             label: "VWP-181361" },
  { id: "181404", kind: "piezometer",   endpoint: "vw",             label: "VWP-181404" },
  { id: "181456", kind: "piezometer",   endpoint: "vw",             label: "VWP-181456" },
  { id: "181461", kind: "piezometer",   endpoint: "vw",             label: "VWP-181461" },
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function readingsPath(node: NodeDef, month?: string): string {
  const suffix = month ? `${month}.csv` : "current.csv";
  if (node.endpoint === "generic-modbus")
    return `/${GATEWAY_ID}/dataserver/current/reading/${node.id}/generic-modbus/${node.id}-6-readings-${suffix}`;
  return `/${GATEWAY_ID}/dataserver/current/reading/${node.id}/vw/${node.id}-readings-${suffix}`;
}

async function fetchCsv(path: string, authHeader: string) {
  const r = await fetch(LS_BASE + path, {
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return { ok: false, status: r.status, text: null as string | null };
  return { ok: true, status: 200, text: await r.text() };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Wall-clock timestamp in the configured timezone → ISO UTC.
// Loadsensing CSVs we've seen: "YYYY-MM-DD HH:mm:ss" (Asia/Makassar).
function parseTs(s: string, tz: string): string | null {
  const v = String(s ?? "").trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    const offsetH = tz === "Asia/Makassar" ? 8 : 0;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h - offsetH, +mi, +(se ?? "0"))).toISOString();
  }
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, mo, d, y, h, mi, se] = m;
    const offsetH = tz === "Asia/Makassar" ? 8 : 0;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h - offsetH, +mi, +(se ?? "0"))).toISOString();
  }
  return null;
}

type ParsedReading = { ts: string; channel: string; value: number };

// The CSV reserves slots for 50 sensors plus Eng-* engineering values,
// but most are empty on this gateway — so filtering by column name
// would miss valid columns. Skip-on-empty does the right thing.
function parseCsv(text: string) {
  const lines = text.split(/\r?\n/);
  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    const first = (splitCsvLine(lines[i])[0] || "").trim().toLowerCase();
    if (first.startsWith("date-and-time") || first === "date and time" || first === "date") { hi = i; break; }
  }
  if (hi < 0) return { error: "no Date header row found" };

  const meta: Record<string, string> = {};
  for (let i = 0; i < hi; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length >= 2 && cells[0]) meta[cells[0].trim()] = (cells[1] || "").trim();
  }
  const tz = meta["Timezone"] || "Asia/Makassar";

  const columns = splitCsvLine(lines[hi]).map((c) => c.trim());
  const readings: ParsedReading[] = [];
  let dataRowCount = 0;
  let skipped = 0;

  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    dataRowCount++;
    const cells = splitCsvLine(lines[i]);
    const ts = parseTs(cells[0], tz);
    if (!ts) { skipped++; continue; }
    for (let j = 1; j < columns.length && j < cells.length; j++) {
      const raw = (cells[j] || "").trim();
      if (raw === "" || raw === "-" || raw === "NaN") continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      readings.push({ ts, channel: columns[j], value: v });
    }
  }
  return { meta, columns, dataRowCount, skippedRows: skipped, readings };
}

function groupByChannel(rows: ParsedReading[]) {
  const map = new Map<string, { name: string; readings: { ts: string; value: number }[] }>();
  for (const r of rows) {
    let entry = map.get(r.channel);
    if (!entry) { entry = { name: r.channel, readings: [] }; map.set(r.channel, entry); }
    entry.readings.push({ ts: r.ts, value: r.value });
  }
  return Array.from(map.values());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: true, message: "Environment Supabase belum lengkap." });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const url = new URL(req.url);
  const onlyNodeId = url.searchParams.get("node");
  const dryRun = url.searchParams.get("dryRun") === "1";
  const month = url.searchParams.get("month") || undefined; // e.g. "2026-05"
  const authHeader = "Basic " + btoa(`${LS_USER}:${LS_PASS}`);

  const targets = onlyNodeId ? NODES.filter((n) => n.id === onlyNodeId) : NODES;
  if (!targets.length) return jsonResponse(400, { error: true, message: `Unknown node id: ${onlyNodeId}` });

  const t0 = Date.now();

  async function processNode(node: NodeDef) {
    try {
      const fetched = await fetchCsv(readingsPath(node, month), authHeader);
      if (!fetched.ok || !fetched.text) {
        return { node: node.id, label: node.label, ok: false, status: fetched.status };
      }

      const parsed = parseCsv(fetched.text);
      if ("error" in parsed) {
        return { node: node.id, label: node.label, ok: false, error: parsed.error };
      }

      const uniqueChannels = new Set(parsed.readings.map((r) => r.channel));

      if (dryRun) {
        return {
          node: node.id, label: node.label, ok: true, dryRun: true,
          csvBytes: fetched.text.length,
          dataRows: parsed.dataRowCount, skippedRows: parsed.skippedRows,
          readingsParsed: parsed.readings.length,
          uniqueChannels: uniqueChannels.size,
          channelNames: Array.from(uniqueChannels).slice(0, 30),
          sample: parsed.readings.slice(0, 5),
        };
      }

      const payload = {
        node_id: node.id, kind: node.kind, label: node.label, category: node.kind,
        meta: parsed.meta, csv_bytes: fetched.text.length,
        channels: groupByChannel(parsed.readings),
      };
      const { data, error } = await supabase.rpc("ingest_loadsensing_payload", { p_payload: payload });
      if (error) return { node: node.id, label: node.label, ok: false, rpc_error: error.message };
      return {
        node: node.id, label: node.label, ok: true,
        dataRows: parsed.dataRowCount, readingsParsed: parsed.readings.length,
        uniqueChannels: uniqueChannels.size, rpc: data,
      };
    } catch (e) {
      return { node: node.id, label: node.label, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const results: unknown[] = [];
  const BATCH = 3;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(processNode));
    results.push(...settled.map((s) => s.status === "fulfilled" ? s.value : { ok: false, error: String(s.reason) }));
  }

  return jsonResponse(200, { error: false, took_ms: Date.now() - t0, dryRun, month: month ?? "current", count: results.length, results });
});
