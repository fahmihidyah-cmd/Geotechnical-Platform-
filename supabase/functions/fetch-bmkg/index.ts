// ARSIP source live edge function `fetch-bmkg` — deployed v8 (2026-07-23).
// Deploy dilakukan via Supabase MCP/dashboard, BUKAN dari repo ini (lihat supabase/functions/README.md).
// v8: dedup BATCH (1 query per 200 event via .in()) menggantikan 1 query per event per menit
//     yang menumpuk 10 jt panggilan REST + duplikat 116k baris saat badai 503 (insiden 23 Jul 2026).
//     Backstop: UNIQUE index earthquakes(event_id) + handler 23505 di insert.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── BMKG Single Source ───────────────────────
const BMKG_HTML_URL = "https://www.bmkg.go.id/gempabumi/gempabumi-realtime";

// ── Site Configuration ────────────────────
const SITES = [
  { name: "Area WOC",  lat: -2.748761, lon: 122.000297, vs30: 421 },
  { name: "Area Port", lat: -2.725700, lon: 122.028042, vs30: 421 },
];
const PROXIMITY_KM = 100;

function getTarpLevel(pga) {
  if (pga < 0.02) return { level: "LV1", hazard: "Low Seismic Hazard",       action: "Monitor — log only" };
  if (pga < 0.05) return { level: "LV2", hazard: "Moderate Seismic Hazard",  action: "Advisory — priority inspection" };
  if (pga < 0.10) return { level: "LV3", hazard: "High Seismic Hazard",      action: "Alert — inspect all locations" };
  return             { level: "LV4", hazard: "Very High Seismic Hazard",  action: "Danger — halt operations" };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function hypocentralDistance(epicKm, depthKm) {
  return Math.sqrt(epicKm**2 + depthKm**2);
}

function pgaDonovan(M, R) {
  return 1.096 * Math.exp(0.664 * M) * Math.pow(R + 25, -1.55);
}

function parseCoord(str, negativeKeyword) {
  const num = parseFloat(str.replace(/[^0-9.]/g, ""));
  return str.includes(negativeKeyword) ? -num : num;
}

function makeEventId(gempa) {
  const dt = gempa.DateTime.replace(/[-:+]/g, "");
  return dt.slice(0, 15);
}

function parseHtmlTable(html) {
  const results = [];
  const BULAN3 = {
    jan:"01", feb:"02", mar:"03", apr:"04",
    may:"05", mei:"05",
    jun:"06", jul:"07",
    aug:"08", agu:"08", ags:"08", agt:"08",
    sep:"09",
    oct:"10", okt:"10",
    nov:"11",
    dec:"12", des:"12"
  };
  const stripTags = (s) => s
    .replace(/<!--.*?-->/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
    .replace(/\s+/g, ' ').trim();
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const scope = tbodyMatch ? tbodyMatch[1] : html;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(scope)) !== null) {
    const rowHtml = rowMatch[1];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }
    if (cells.length < 6) continue;
    const waktuRaw = cells[1];
    const magStr   = cells[2];
    const kedStr   = cells[3];
    const koordinat= cells[4];
    const wilayah  = cells[5];
    if (!waktuRaw || !magStr) continue;
    const wParts = waktuRaw.replace(/ (WIB|WITA|WIT)/,'').trim().split(/\s+/);
    if (wParts.length < 4) continue;
    const dd  = wParts[0].padStart(2,"0");
    const monthKey = (wParts[1] || "").slice(0,3).toLowerCase();
    const mm  = BULAN3[monthKey];
    if (!mm) { console.warn(`Bulan tak dikenal: "${wParts[1]}" pada "${waktuRaw}" — baris dilewati`); continue; }
    const yy  = wParts[2];
    const jam = wParts[3].replace(/\./g,":");
    const dateTime = `${yy}-${mm}-${dd}T${jam}+07:00`;
    const eventMs = Date.parse(dateTime);
    const nowMs   = Date.now();
    const HARI    = 86400000;
    if (Number.isNaN(eventMs)) {
      console.error(`[VALIDASI] Tanggal invalid dari "${waktuRaw}" → "${dateTime}" — baris dilewati`);
      continue;
    }
    if (eventMs > nowMs + HARI) {
      console.error(`[VALIDASI] Tanggal di MASA DEPAN (${dateTime}) dari "${waktuRaw}" — kemungkinan parsing salah, dilewati`);
      continue;
    }
    if (eventMs < nowMs - 90 * HARI) {
      console.error(`[VALIDASI] Tanggal terlalu LAMA (${dateTime}) dari "${waktuRaw}" — kemungkinan parsing salah, dilewati`);
      continue;
    }
    const coordNorm = koordinat.replace(/,/g,".");
    const lintangMatch = coordNorm.match(/([\d.]+)\s*(LS|LU)/i);
    const bujurMatch   = coordNorm.match(/([\d.]+)\s*(BT|BB)/i);
    const lintangVal   = lintangMatch ? `${lintangMatch[1]} ${lintangMatch[2].toUpperCase()}` : "";
    const bujurVal     = bujurMatch   ? `${bujurMatch[1]} ${bujurMatch[2].toUpperCase()}`   : "";
    const magnitude = parseFloat(magStr.replace(",","."));
    if (isNaN(magnitude)) continue;
    results.push({
      DateTime:    dateTime,
      Magnitude:   magStr.replace(",","."),
      Kedalaman:   kedStr,
      Lintang:     lintangVal,
      Bujur:       bujurVal,
      Coordinates: coordNorm.replace(/(LS|LU)-/i, '$1, ').replace(/\s+/g,' '),
      Wilayah:     wilayah,
      Potensi:     "-",
      Dirasakan:   "-",
      Shakemap:    "-",
    });
  }
  return results;
}

Deno.serve(async (_req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const htmlText = await fetch(BMKG_HTML_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    }).then(r => r.ok ? r.text() : null).catch(() => null);
    if (!htmlText) {
      return Response.json({ status: "error", message: "Failed to fetch BMKG realtime page" }, { status: 502 });
    }
    const allGempaMap = new Map();
    const htmlGempaList = parseHtmlTable(htmlText);
    console.log(`HTML scrape: ${htmlGempaList.length} events found`);
    for (const gempa of htmlGempaList) {
      if (!gempa?.DateTime) continue;
      const eventId = makeEventId(gempa);
      if (!allGempaMap.has(eventId)) allGempaMap.set(eventId, gempa);
    }
    console.log(`Total unique events from BMKG realtime: ${allGempaMap.size}`);

    // ── Dedup BATCH: 1 query per 200 event (dulu: 1 query per event per menit → 10 jt panggilan).
    // Backstop tetap ada: UNIQUE index earthquakes(event_id) + handler 23505 di insert.
    const existingSet = new Set();
    const allIds = [...allGempaMap.keys()];
    for (let i = 0; i < allIds.length; i += 200) {
      const chunk = allIds.slice(i, i + 200);
      const { data: ex, error: exErr } = await supabase
        .from("earthquakes").select("event_id").in("event_id", chunk);
      if (exErr) { console.error("dedup batch error:", exErr.message); continue; }
      (ex || []).forEach(r => existingSet.add(r.event_id));
    }

    const insertedList = [];
    const skippedList = [];
    let alertsCreated = 0;
    for (const [eventId, gempa] of allGempaMap) {
      if (existingSet.has(eventId)) { skippedList.push(eventId); continue; }
      const magnitude = parseFloat(gempa.Magnitude);
      const depthKm   = parseFloat(gempa.Kedalaman.replace(/[^0-9.]/g, ""));
      const epicLat   = parseCoord(gempa.Lintang, "LS");
      const epicLon   = parseCoord(gempa.Bujur,   "BB");
      const siteResults = SITES.map((site) => {
        const R_epi  = haversineKm(epicLat, epicLon, site.lat, site.lon);
        const R_hypo = hypocentralDistance(R_epi, depthKm);
        const pga    = pgaDonovan(magnitude, R_hypo);
        const tarp   = getTarpLevel(pga);
        return {
          site_name:        site.name,
          distance_epi_km:  Math.round(R_epi  * 10) / 10,
          distance_hypo_km: Math.round(R_hypo * 10) / 10,
          pga_donovan_g:    Math.round(pga * 1000000) / 1000000,
          tarp_level:       tarp.level,
          hazard:           tarp.hazard,
          action:           tarp.action,
          within_100km:     R_epi <= PROXIMITY_KM,
          // Proximity (<100km) trigger DISABLED per request — alert only on severity (TARP>=LV2, pga>=0.02)
          requires_alert:   (pga >= 0.02),
        };
      });
      const tarpOrder = { LV1:1, LV2:2, LV3:3, LV4:4 };
      const maxTarp = siteResults.reduce((max, s) =>
        tarpOrder[s.tarp_level] > tarpOrder[max.tarp_level] ? s : max, siteResults[0]);
      const { data: inserted, error } = await supabase
        .from("earthquakes")
        .insert({
          event_id:    eventId,
          tanggal:     new Date(gempa.DateTime).toISOString(),
          magnitude,
          kedalaman:   gempa.Kedalaman,
          wilayah:     gempa.Wilayah,
          coordinates: gempa.Coordinates,
          lintang:     gempa.Lintang,
          bujur:       gempa.Bujur,
          potensi:     gempa.Potensi,
          dirasakan:   gempa.Dirasakan,
          shakemap:    gempa.Shakemap,
          status:      maxTarp.tarp_level,
        })
        .select().single();
      if (error) {
        if (error.code === "23505") { skippedList.push(eventId); continue; }
        console.error("Insert error:", error);
        continue;
      }
      // Alert: HANYA severity (TARP>=LV2). Trigger jarak <=100km dinonaktifkan.
      const qualifyingSites = siteResults.filter(s => s.requires_alert);
      if (qualifyingSites.length > 0 && inserted) {
        const govSite = qualifyingSites.reduce(
          (mx, s) => s.pga_donovan_g > mx.pga_donovan_g ? s : mx, qualifyingSites[0]);
        const { data: recipients } = await supabase
          .from("alert_recipients")
          .select("id")
          .eq("is_active", true);
        if (recipients && recipients.length > 0) {
          const logs = recipients.map(r => ({
            earthquake_id: inserted.id,
            recipient_id:  r.id,
            alert_type:    govSite.tarp_level,
            status:        "pending",
            response: JSON.stringify({
              site:             govSite.site_name,
              pga_g:            govSite.pga_donovan_g,
              tarp:             govSite.tarp_level,
              hazard:           govSite.hazard,
              action:           govSite.action,
              distance_epi_km:  govSite.distance_epi_km,
              distance_hypo_km: govSite.distance_hypo_km,
              within_100km:     govSite.within_100km,
              trigger:          "Severity (TARP>=LV2)",
            }),
            created_at: new Date().toISOString(),
          }));
          const { error: logErr } = await supabase.from("alert_logs").insert(logs);
          if (!logErr) alertsCreated += logs.length;
        }
      }
      insertedList.push({
        event_id:  eventId,
        magnitude,
        wilayah:   gempa.Wilayah,
        max_tarp:  maxTarp.tarp_level,
        sites:     siteResults.map(s => ({
          site:    s.site_name,
          pga_g:   s.pga_donovan_g,
          tarp:    s.tarp_level,
          dist_km: s.distance_hypo_km,
        }))
      });
    }
    console.log(`Inserted: ${insertedList.length}, Skipped: ${skippedList.length}, AlertsCreated: ${alertsCreated}`);

    // ── WA built-in: hanya picu saat ADA alert baru (gantikan cron WA tiap menit) ──
    let waTriggered = false;
    if (alertsCreated > 0) {
      try {
        const waResp = await fetch(`${SUPABASE_URL}/functions/v1/send-alert-wa`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "apikey": SERVICE_KEY,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        waTriggered = waResp.ok;
        console.log(`send-alert-wa invoked: HTTP ${waResp.status}`);
      } catch (e) {
        console.error("WA invoke failed:", e);
      }
    }

    return Response.json({
      status:       "done",
      inserted:     insertedList.length,
      skipped:      skippedList.length,
      alertsCreated,
      waTriggered,
      data:         insertedList,
    });
  } catch (err) {
    console.error("fetch-bmkg error:", err);
    return Response.json({ status: "error", message: String(err) }, { status: 500 });
  }
});
