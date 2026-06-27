// pull-fortuna-aws — Supabase Edge Function
//
// Polls Fortuna AWS (Automatic Weather Station) API and ingests
// rainfall, temperature, humidity, wind, and other weather data
// into monitoring.devices / monitoring.sensors / monitoring.readings.
//
// The weather data feeds into the EWS (Early Warning System) as a
// MODIFIER — rainfall thresholds adjust displacement trigger levels.
//
// Scheduling: pg_cron calls this every 10 minutes via net.http_post.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Fortuna API Configuration ----
// TODO: Replace with actual Fortuna API endpoint and credentials
const FORTUNA_BASE = Deno.env.get("FORTUNA_API_URL") || "https://fortuna.example.com/api";
const FORTUNA_TOKEN = Deno.env.get("FORTUNA_API_TOKEN") || "";

// AWS station IDs to poll
const AWS_STATIONS: { id: string; label: string }[] = [
  // TODO: Add actual Fortuna station IDs
  // { id: "AWS-001", label: "AWS Site 1" },
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

// Expected Fortuna API response structure (adjust to actual API)
type FortunaReading = {
  timestamp: string;
  rainfall_mm_hr?: number;
  rainfall_mm_min?: number;
  rainfall_accumulation_mm?: number;
  temperature_c?: number;
  humidity_pct?: number;
  wind_speed_ms?: number;
  wind_direction_deg?: number;
  pressure_hpa?: number;
};

async function fetchFortunaData(stationId: string): Promise<FortunaReading[] | null> {
  try {
    const url = `${FORTUNA_BASE}/stations/${stationId}/readings?latest=true`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${FORTUNA_TOKEN}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: true, message: "Supabase env not configured." });
  }

  if (!FORTUNA_TOKEN) {
    return jsonResponse(500, {
      error: true,
      message: "FORTUNA_API_TOKEN not set. Configure via Supabase Dashboard > Edge Functions > Secrets.",
    });
  }

  if (AWS_STATIONS.length === 0) {
    return jsonResponse(200, {
      error: false,
      message: "No AWS stations configured yet. Add station IDs to AWS_STATIONS array.",
      stations: [],
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const t0 = Date.now();
  const results: unknown[] = [];

  for (const station of AWS_STATIONS) {
    try {
      const readings = await fetchFortunaData(station.id);
      if (!readings || readings.length === 0) {
        results.push({ station: station.id, label: station.label, ok: false, error: "No data" });
        continue;
      }

      // Map Fortuna channels to our sensor naming convention
      const channels: { name: string; readings: { ts: string; value: number }[] }[] = [];

      const channelMap: Record<string, (r: FortunaReading) => number | undefined> = {
        "RainFall Hourly": (r) => r.rainfall_mm_hr,
        "RainFall Minute": (r) => r.rainfall_mm_min,
        "RainFall Accumulation": (r) => r.rainfall_accumulation_mm,
        "Temperature": (r) => r.temperature_c,
        "Humidity": (r) => r.humidity_pct,
        "Wind Speed": (r) => r.wind_speed_ms,
        "Wind Direction": (r) => r.wind_direction_deg,
        "Atmosphere": (r) => r.pressure_hpa,
      };

      for (const [chName, extractor] of Object.entries(channelMap)) {
        const chReadings: { ts: string; value: number }[] = [];
        for (const r of readings) {
          const v = extractor(r);
          if (v !== undefined && v !== null && Number.isFinite(v)) {
            chReadings.push({ ts: new Date(r.timestamp).toISOString(), value: v });
          }
        }
        if (chReadings.length > 0) {
          channels.push({ name: chName, readings: chReadings });
        }
      }

      if (channels.length === 0) {
        results.push({ station: station.id, ok: false, error: "No valid channel data" });
        continue;
      }

      const payload = {
        node_id: station.id,
        kind: "aws",
        label: station.label,
        category: "aws_vaisala",
        meta: {},
        csv_bytes: 0,
        channels,
      };

      const { data, error } = await supabase.rpc("ingest_loadsensing_payload", { p_payload: payload });
      if (error) {
        results.push({ station: station.id, ok: false, rpc_error: error.message });
      } else {
        results.push({ station: station.id, label: station.label, ok: true, channels: channels.length, rpc: data });
      }
    } catch (e) {
      results.push({
        station: station.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return jsonResponse(200, {
    error: false,
    took_ms: Date.now() - t0,
    count: results.length,
    results,
  });
});
