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
- **Inklinometer** EWS pakai **INCREMENTAL per-titik** (governing = sensor terparah lintas Axis A&B),
  BUKAN kumulatif kolom (kumulatif bias di top-hole). **Complete-profile QC era-aware**:
  pakai max sensor-count jendela 4-hari (BUKAN max global) — supaya alat yang jumlah sensornya
  berubah (mis. 108102: 8→15 sensor) tidak membuang data lama. Jangan balik ke global-max.
- **Chart inklinometer (`inc_profile_daily`, `inc_top_displacement_series`)**: pakai tabel
  `monitoring.inc_initial_baseline` (sin+depth, single source), **buang sensor mati/blip**
  (n < max(3, 20% count device di jendela) → cegah blip toe basi mengorupsi kumulatif, dulu
  spike palsu −233mm 108102), **anchor deepest-alive=0** (konsisten `inclinometer.html`).
- **Dashboard `monitoring.html` tab Inklinometer = LIVE OVERVIEW**: 4 hole berurutan, heatmap
  A (kiri) · B (kanan) via `inc_heatmap_series`, badge EWS + **governing** (incremental tertinggi
  sensor hidup + kedalaman + tag FROZEN bila railed). Link `inclinometer.html?dev=<id>` untuk analisis lanjut.
- **`manual_state` (On/Off/Auto) DIHAPUS** — dulu kosmetik (tak dihormati EWS/RPC). Kolom di-reset
  `auto`; fungsi `set_sensor_manual_state` di-drop. Status sensor = otomatis dari kesegaran data.
- **Sensor-health inklinometer di `evaluate_ews`** (aturan pemilik, sumber tunggal DB):
  - **KOSONG/RUSAK** = sel data tak keluar angka → tertinggal >24 jam dari sensor tersegar device
    (bukan outage device-wide) → **dikeluarkan dari velocity DAN magnitude**. (Dulu bocor: nilai
    basi sn5 108102 −190mm memicu JINGGA palsu; sekarang benar KUNING dari sn10 ~90mm.)
  - **RAILED/BEKU** = masih melapor tapi `stddev(sin,3hr) < 5e-4` DAN `|disp|≥20mm` DAN n≥8 →
    **magnitude TETAP dipakai** (shear nyata), **velocity DINOLKAN** (hindari rasa aman palsu).
    `inc_heatmap_series` mengembalikan `is_railed` per sensor; front-end `inclinometer.html`
    menampilkan hatch amber + banner "FROZEN — magnitude valid, velocity tak terpantau, verifikasi lapangan".
    Detail audit di `ews_device_trigger.details`: `excluded_empty`, `railed_count`.
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

## Roadmap dashboard (audit Jul 2026 — disepakati pemilik; kerjakan BERURUTAN)
Prinsip: **cepat → jujur → pintar**. Tiap item ditulis: apa · di mana · cara · selesai-bila.

### FASE 0 · Performa `monitoring.html`
(fakta terukur: 197 KB monolitik; boot ≈20 query paralel ≈1–2 MB; heavy pass tiap 10 mnt
+ tiap tab fokus; `render()` me-rebuild DOM+16 chart+peta setiap `loadAll`)
1. **Stop rebuild DOM total** *(dampak terbesar)* — `loadAll()` berakhir memanggil `render()`
   yang `root.innerHTML=tpl()`. Ubah: `render()` penuh HANYA saat `STATE.view` berubah;
   bila view sama → panggil updater per-view (`fillOverview`/`drawCharts`/`draw*Tab`) dgn pola
   `chart.data.datasets[..]=..; chart.update('none')` (contoh pola sudah ada di `refreshAtCursor`
   inclinometer.html). Peta Leaflet JANGAN dibuat ulang — `buildMap` sekali, lalu update layer
   (pola `overlays.*.clearLayers()` sudah ada). Selesai-bila: klik antar refresh tak ada flicker
   peta/chart & memory stabil.
2. **XLSX lazy-load** — hapus `<script ... xlsx.full.min.js>` dari `<head>`; di `exportTable()`
   injeksi script on-demand (sekali) sebelum pakai `XLSX.*`. Hemat ~0.9 MB boot.
3. **Fetch per-view + throttle fokus** — pindahkan query khusus view dari `heavyP` (mis. `inc7`,
   `vwp7`, `incTop`, `incGov`) ke pola `activeP` yang sudah ada (hanya view aktif). Handler
   `visibilitychange` tambah guard `if(now-lastLoad<60_000) return;`.
4. **RPC `dashboard_snapshot()`** — gabungkan 8 query ringan per-poll: `baseP`
   (`v_instrument_sensors`,`v_rain_status`,`v_rain_summary`,`v_rain_daily`) + `ews_latest` +
   `ews_alerts_recent` + rain24 + `inst_latest_temp` → 1 SECURITY DEFINER JSONB. FE: 1 panggilan.

### FASE 1 · Konsistensi data (akar "tidak match")
1. **Buang dummy tab Inspection** — sumbernya **RPC DB `inspection_analytics`** (BUKAN front-end)
   + baris `inspections.is_dummy=true`. Tulis ulang RPC: `summary/mttr_weekly/gap_cumulative/
   risk_trend_monthly` murni dari data riil (`opened_at`,`closed_at`; MTTR=avg(closed-opened)),
   exclude `is_dummy`. Hapus banner "note-dev DUMMY" di tpl Inspection. Selesai-bila: angka tab
   Inspection == query manual tabel `inspections`.
2. **Satu bahasa pergerakan inklinometer** — headline dashboard & EWS = **governing incremental
   RESULTAN √(A²+B²)** per sensor hidup (JANGAN A-only; kasus nyata: A 97.6 vs resultan ≈101 mm
   @21m). Cek/ubah `inc_governing_series` & `evaluate_ews` (saat ini max per-axis terpisah).
   Chart "top displacement" tetap boleh tampil tapi berlabel metode ("kumulatif kolom era-aware")
   sebagai sekunder. Selesai-bila: angka headline dashboard == `ews_device_latest.cumulative_disp_mm`.
3. **Standar WITA utk agregat harian** — audit semua RPC berbucket hari: pakai
   `(ts AT TIME ZONE 'Asia/Makassar')::date` (contoh benar: `inc_profile_daily`,
   `shift_round_checks_for_report`); `date_bin` sub-harian (1–6 jam) biarkan. Kandidat periksa:
   `v_rain_daily`, `inspection_analytics`, chart mingguan. Selesai-bila: tak ada nilai "geser
   sehari" saat dibandingkan spreadsheet site (WITA).
4. **Chip "data as-of" per panel** — dari `v_instrument_sensors.latest_ts` max per `kind`;
   komponen kecil di header tiap card (ext/inc/vwp/aws). Global chip tetap ada. Feed down
   → chip merah "FEED DOWN sejak <t>".
5. **QC artefak transien** — tandai `readings.qc='BAD_SENTINEL'` utk frame garbage historis
   108102 (29 Jun 07:2x; 16–17 Jul burst 782/1192 mm) dan tambah aturan post-ingest: sensor yang
   stale >24 jam lalu muncul ≤2 frame dgn |Δdisp| besar → auto-flag. (EWS sudah kebal via
   exclude-empty; ini supaya chart/heatmap juga bersih permanen.)

### FASE 2 · Fitur advance (kerjakan setelah F0–F1)
- **Threshold config-driven**: tabel `monitoring.thresholds(kind,metric,level,value,unit,active,
  updated_by,updated_at)` + halaman admin kecil; `evaluate_ews` & garis chart baca dari tabel
  (ganti konstanta TH_*). Wajib audit-log perubahan.
- **Forecast inverse-velocity (Fukuzono)**: RPC `inc_inverse_velocity(p_device)` — regresi linier
  1/v vs t (jendela 7–14 hari, sensor governing, hanya bila v naik & v>ambang noise) → return
  {eta_date, r2, v_now}. UI: garis proyeksi putus-putus + ETA lintas ambang (use case nyata:
  proyeksi 100 mm WDN2-01 ±22–24 Jul yang kemarin dihitung manual).
- **Unifikasi 3 sistem risiko** (EWS instrumen · inspeksi visual · PERA): RPC
  `location_governing_risk()` = MAX(level) per lokasi + sumbernya → matrix 5×5 dashboard jadi
  live (desain L×C sudah disepakati di butir PR #2).
- **Alarm workflow**: tabel `ews_alert_ack(alert_id,ack_by,ack_at,note,assigned_to)` + UI di
  panel alert; level naik tanpa ack ≤N mnt → tampil menonjol.
- **Tabel `events`** (blasting, perbaikan alat, hujan ekstrem, kalibrasi): FE marker vertikal di
  SEMUA chart waktu (plugin `eqPlugin` sudah ada polanya utk gempa — generalisasi).
- **AI Daily Report** (desain final, tinggal eksekusi): RPC `ai_report_snapshot()` (JSON ringkas:
  ews_latest + per-device + vwp + governing inc + hujan + gempa + inspeksi open + kesehatan
  sensor) → Edge Fn `generate-ai-report` (provider-agnostic via secret `AI_PROVIDER`+
  `GEMINI_API_KEY`/`ANTHROPIC_API_KEY`; mulai Gemini free) → temperature 0, WAJIB menyitir angka
  snapshot, output JSON section → simpan `monitoring.ai_reports(report_date,model,input_snapshot,
  report,tokens)` → panel FE + label "AI-generated, advisory". **HARAM memicu alarm/WA.**
  Cron harian 06:00 WITA (=22:00 UTC).

### FASE 3 · Analytics
Correlation explorer hujan→VWP→displacement (RPC cross-correlation dgn lag 0–72 jam) ·
instrument health score/uptime per device (dead/frozen/stale dari `details`) · partisi bulanan /
continuous aggregate `readings` bila >5 jt baris · opsional embed Grafana read-only.

### FASE 4 · Self-service & keberlanjutan (NORTH STAR — kelas Trimble 4D / GeoMoS / MonitorIQ)
Tujuan pemilik: platform **customizable via UI admin tanpa kode**, dan **tetap hidup saat
pemilik resign**. Semua konfigurasi pindah dari hardcode → tabel DB + halaman `admin.html`:
1. **Registry instrumen via UI** — CRUD `monitoring.devices`/`sensors`/`inc_initial_baseline`/
   `vwp_calibration` + koordinat & lokasi: tambah/nonaktifkan alat TANPA migrasi SQL.
   (Onboarding alat baru spt SYSCOM accelero cukup isi form.)
2. **Threshold & TARP editor** (perluasan F2 thresholds) + editor teks tindakan TARP per level.
3. **Penerima alarm & eskalasi via UI** — CRUD `alert_recipients` + jadwal/level per penerima.
4. **Manajemen user & role via UI** — CRUD `user_roles` (approve pending, set validator/admin).
5. **Report scheduler** — pilih template (shift/harian/AI report), jadwal, penerima email/WA.
6. **Widget dashboard configurable** — tabel `dashboard_config` per role: pilih panel & urutan.
Prasyarat teknis SUDAH ada (semua logika di DB); ini murni kerja UI admin + RLS admin-only.

## KEBERLANJUTAN / BUS FACTOR (risiko #1 — lebih penting dari semua fitur)
Saat ini SEMUA akun di bawah individu pemilik — bila resign, akses platform ikut hilang:
| Aset | Sekarang | Harus jadi |
|---|---|---|
| Supabase (project `dhddckamrkfleuigrsip`) | akun pribadi gmail | **Organization** perusahaan, ≥2 owner |
| GitHub repo | `fahmihidyah-cmd` (pribadi) | org perusahaan / transfer + ≥2 admin |
| Cloudflare (worker `gcmp` + aerial + domain) | akun pribadi | akun/email perusahaan, ≥2 member |
| Domain (rencana `gmplens.com`) | — | daftar atas nama perusahaan + auto-renew |
| WhatsApp API, Loadsensing, Argatech, API AI | kredensial pribadi/campur | vault perusahaan (mis. 1Password/Bitwarden tim) |
Langkah wajib sebelum handover: (1) migrasi akun ke org/email perusahaan; (2) simpan semua
secret di vault tim; (3) tunjuk & latih **≥2 admin**; (4) tulis **runbook operasional non-dev**
(`RUNBOOK.md`: feed down→cek apa; alarm→siapa; sensor rusak→prosedur; deploy→langkah;
restore backup→langkah) — CLAUDE.md ini = handover DEV, runbook = handover OPS;
(5) uji "hari tanpa pemilik": admin lain melakukan 1 deploy + 1 ubah threshold + 1 respon alarm
tanpa bantuan; (6) rencana on-prem (lihat dokumen migrasi) = jalur kemandirian penuh dari
akun cloud pribadi.

### UX/UI (audit terpisah — eksekusi bertahap, bisa nyicil bareng F0–F2)
1. **3 persona**: shift crew (HP — grid 344px & tombol `.mini` tak ramah jempol; buat breakpoint
   mobile-first), engineer (desktop, default sekarang), manajemen (**TV mode**: fullscreen,
   font besar, high-contrast, auto-carousel — carousel sudah ada, tinggal mode tampilannya).
2. **Banner status EWS sticky** di SEMUA tab (baca `DATA.ews.status`): terbaca <3 dtk dari 3 m;
   warna+ikon+teks level & alasan. *(Prioritas tertinggi UX, murah.)*
3. **Aksesibilitas**: minimal font 11px utk data penting (banyak 8–10px sekarang); level risiko
   jangan warna-saja → tambah ikon/pola (colorblind-safe); touch target ≥44px.
4. **Konsistensi**: bahasa → ID semua; tema → gelap semua halaman (inspeksi/pera masih terang);
   SEMUA timestamp berlabel **WITA**.
5. **Empty/feed-down state**: chart kosong dilarang — tampilkan status eksplisit ("FEED
   LOADSENSING DOWN sejak <t> · data terakhir <t>") dari freshness per kind (lihat F1.4).
6. **Alarm UX**: perubahan level → toast/banner persist sampai di-ack (nyambung alarm workflow
   F2); jangan tampilkan flapping mentah (tahan dgn persistence yang sudah ada di EWS).
7. **IA/navigasi**: satukan pola — sidebar (utama) + link "Advanced →" utk halaman standalone;
   carousel hanya utk TV mode; back/breadcrumb konsisten di halaman lapangan.
8. **Chart UX**: semua garis ambang berlabel + unit di axis; tooltip seragam (format tanggal
   WITA); zoom/pan (chartjs-plugin-zoom, lazy-load); tombol export PNG/CSV per chart.

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
