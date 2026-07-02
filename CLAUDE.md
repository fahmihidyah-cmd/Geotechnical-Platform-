# Geotechnical Monitoring Platform — Project Guide

Slope-stability + earthquake-early-warning + shift-monitoring platform for
**PT Vale Indonesia · IGP Morowali · Bahodopi Block 2 & 3**.

> **Prinsip arsitektur (aturan tegas pemilik):** SEMUA pengolahan data (kalibrasi,
> kumulatif, QC, risk, EWS) ada di **DATABASE**. Front-end **hanya membaca & menampilkan**.
> Jangan duplikasi logika di front-end, jangan mengarang/menampilkan data salah,
> jangan ganggu data mentah.

## Stack
- **Frontend:** single-file HTML (vanilla JS + Chart.js + Leaflet, **tanpa build step**).
  Shared `common.js` namespace `GMS`: `GMS.sb` (supabase client), `GMS.getSession`,
  `GMS.getProfile`, `GMS.guard`, `GMS.esc`, `GMS.fmtDate`, `GMS.header`.
- **Backend:** Supabase — project id **`dhddckamrkfleuigrsip`**. Postgres + RLS +
  SECURITY DEFINER RPC (return **JSONB** untuk melewati cap 1000 baris PostgREST) +
  pg_cron + Realtime + Edge Functions (Deno).
- **Hosting:** Cloudflare deploy website dari branch **`main`** di GitHub.
  App URL `gcmp.fahmihidyah.workers.dev`. Tile aerial drone via Worker terpisah
  `young-mouse-1ee2.fahmihidyah.workers.dev`.

## Halaman frontend
`index.html` (login) · `monitoring.html` (dashboard executive + monitoring/trends +
extensometer + inclinometer + vwp + aws + inspection) · `eews.html` (gempa) ·
`inspeksi.html` (form inspeksi visual) · `pera.html` (pasca-gempa) ·
`shift.html` (cycle/round check tiap 2 jam) · `shiftreport.html` (form shift report) ·
`shiftreport_pdf.html` (laporan PDF) · `database.html` (records/export) ·
`report.html` · `risk_report.html` · `validasi.html`. Plus `common.js`, `common.css`,
`sw.js` (PWA), `manifest.json`.

## Data pipeline (pg_cron → Edge Function → DB)
Edge function source live disimpan di `supabase/functions/` (lihat README di sana).
**Penarik data = Supabase Edge Function, BUKAN GitHub.**

| pg_cron job | Frekuensi | Edge fn | Data |
|---|---|---|---|
| `pull-argatech-2min` | 2 mnt | `pull-argatech-sensors` | Extensometer + AWS (device 372, 373) |
| `pull-loadsensing-hourly` | 15 mnt | `pull-loadsensing` | Inclinometer + VWP (`current.csv`) |
| `pull-loadsensing-backfill-6h` | 6 jam | `pull-loadsensing?month=YYYY-MM` | Backfill CSV bulanan (isi lubang gap gateway) |
| `fetch-bmkg-every-minute` | **1 mnt** | `fetch-bmkg` | Gempa BMKG → PGA/TARP → **auto WA** (`send-alert-wa`). **JANGAN turunkan frekuensi** (latensi notif). Dedup `event_id`. |
| `ews-evaluate-10min` | 10 mnt | — | `monitoring.evaluate_ews()` |
| `prune-ingestion-logs` | harian 02:00 UTC | — | `monitoring.prune_ingestion_logs(7)` |

Ingest ke `monitoring.readings` via `ingest_loadsensing_payload` / `parse_raw_payload`,
dedup `ON CONFLICT (sensor_id, ts) DO NOTHING` (idempoten — kursor = `readings`, bukan log).
**Full-backfill:** `ingest_loadsensing_payload` TIDAK lagi pakai filter `ts > max` — semua
reading dicoba insert, dedup murni via `ON CONFLICT`. Jadi tarik CSV bulanan mengisi lubang
riwayat (gap gateway mati) tanpa jadi hole permanen. Datalogger Worldsensing store-and-forward.

## QC saat ingest (non-destruktif)
`monitoring.readings.qc` + trigger `trg_readings_qc` → `classify_reading_value(value)`:
`VALID` · `NODATA` · `BAD_NONFINITE` · `BAD_SENTINEL` (|v|≥1e6, mis. 4294967.295 sentinel uint32).
Hanya **menandai**, tidak membuang. QC domain (band frekuensi VWP, profil inklinometer)
tetap di **read-time** (view/RPC).

## Tabel penting (schema `public`, `monitoring`)
- `monitoring.readings` (id, sensor_id, ts, value, created_at, qc) — time-series utama (~25k baris/hari ≈ 2 GB/thn).
- `monitoring.sensors`, `monitoring.devices`, `monitoring.vwp_calibration`.
- `monitoring.ingestion_batches` + `raw_api_payloads` (log audit, dipangkas 7 hari; FK cascade).
- `monitoring.ews_evaluations`, `ews_device_trigger`, `ews_alert_log`.
- `public.earthquakes`, `alert_logs`, `alert_recipients`, `locations`.
- `public.shift_reports`, `shift_report_instruments`, `shift_round_checks`.
- `public.inspections`, `inspection_photos`/`_documentation`/`_risk_areas` (data dummy sudah dihapus), `pera_assessments`, `pera_questions` (template — JANGAN hapus).

## RPC kunci (SECURITY DEFINER, JSONB, grant anon/authenticated)
`evaluate_ews()` · `ews_latest()` · `ews_device_latest()` · `ews_alerts_recent(p_limit)` ·
`instrument_series(p_kind,p_from,p_to,p_every)` · `instrument_series_json(...)` ·
`inc_top_displacement_series(p_from,p_to,p_every)` · `inc_profile_daily(p_from,p_to)` ·
`inc_initial_baseline()` · `vwp_pressure_series(p_from,p_to,p_every)` ·
`vwp_device_latest()` · `inst_latest_temp()` · `shift_round_checks_for_report(p_tanggal,p_shift)` ·
`prune_ingestion_logs(p_keep_days)` · `classify_reading_value(p_value)`.
Views: `v_instrument_sensors`, `v_instrument_readings`, `v_instrument_points`,
`v_vwp_pressure`, `v_inspection_risk_areas`, `v_aws_stats`, `v_rain_*`.

## Domain logic — EWS / TARP (sumber tunggal: `evaluate_ews`, untuk ext + inklinometer)
- Velocity: **Medium >4.1 mm/hari** (1.5 m/thn) · **High >50 mm/hari** (1.5 m/bln) · **Very High >62.5 mm/jam** (1.5 m/hari).
- Kumulatif: **Medium >50 mm · High >100 mm**.
- Velocity ratio: JINGGA >1.25 · MERAH >1.5. Modifier hujan ×0.5; persistence N=3; de-eskalasi M=6; voting 2-of-n; fail-safe.
- Level HIJAU/KUNING/JINGGA/MERAH = Low/Medium/High/Very High. `GAUGE_LEN=3000mm`.
- **Inklinometer kumulatif** = Σ depth-sensor `(sin − baseline)*3000`. **Complete-profile QC era-aware**:
  pakai max sensor-count jendela 4-hari (BUKAN max global) — supaya alat yang jumlah sensornya
  berubah (mis. 108102: 8→15 sensor) tidak membuang data lama. Jangan balik ke global-max.
- **VWP** (`vwp_device_latest`): rate-of-rise + baseline 7-hari. Medium ≥5 kPa/hari ATAU ≥10 kPa
  vs baseline; High ≥10/≥20; Very High ≥20/≥40. Modifier hujan ×0.5. **Belum** masuk voting `evaluate_ews`.
- **PGA gempa** (`fetch-bmkg`): threshold saat ini **0.02/0.05/0.10 g — SALAH**, resmi 0.10/0.20/0.30 g (ditunda).

## Workflow deploy
1. Develop di branch **`claude/monitoring-live-realtime-data-ksiwk1`**.
2. **Validasi JS** sebelum deploy: `node` + `vm.Script` pada tiap `<script>` inline.
3. Commit → push branch → `git checkout main && git pull` → `merge --no-ff` → push `main` (Cloudflare deploy).
4. Perubahan DB diterapkan langsung via Supabase MCP (`apply_migration`/`execute_sql`), **tidak** di repo.
5. Storage: DB ~193 MB (Pro 8 GB). Foto di Supabase Storage bucket (kuota 100 GB terpisah).
   PDF di-generate di sisi client (tidak disimpan). Log ingest dipangkas 7 hari otomatis.

## PR / pekerjaan yang masih terbuka
1. **VWP masuk voting EWS global** (`evaluate_ews`) — sekarang VWP hanya di shift report.
2. **Risk matrix L×C** (Likelihood×Consequence) untuk inspeksi sebagai fungsi DB
   (desain disepakati: inspeksi visual = Tier-1, instrument validasi, governing = MAX,
   de-eskalasi perlu validator). Inspeksi masih composite-SUM. 3 sistem risk paralel
   (EWS / inspeksi / PERA) belum disatukan. Matrix 5×5 di dashboard masih dekoratif.
3. **PGA threshold 0.10/0.20/0.30 g** di `fetch-bmkg` (ditunda).
4. **Peta di PDF shift report**: aerial drone baru muncul di file ter-download bila
   Worker aerial mengirim header `Access-Control-Allow-Origin: *` (1 baris). Bila tidak,
   alihkan peta PDF ke Esri. (Download PDF 1-klik + halaman peta landscape sudah jalan.)
5. **Edge function repo**: `supabase/functions/pull-fortuna-aws` = orphan (mati).
   `fetch-bmkg`, `send-alert-email`, `send-alert-wa` belum diarsip ke repo.
6. **Dashboard customizable** (config-driven threshold + pilih widget / Grafana) — baru diskusi.
7. **Very High akumulasi 150 mm** di chart monitoring = placeholder; konfirmasi nilai baku ke geotek.
8. (Opsional) **Rollup `readings`** bila tumbuh besar (sekarang simpan semua raw).
