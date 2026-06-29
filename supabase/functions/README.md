# Supabase Edge Functions — Data Pipeline

**Penting:** yang **menarik data sensor adalah Edge Function di Supabase**, dijadwalkan
oleh **pg_cron** (juga di Supabase). **GitHub TIDAK menarik data** — GitHub hanya
menyimpan kode website (HTML) yang disajikan Cloudflare. Folder ini adalah **salinan
arsip/version-control** dari fungsi yang berjalan di Supabase. Sumber kebenaran yang
benar-benar berjalan ada di Supabase; perbarui repo ini setiap kali fungsi diubah.

```
GitHub (kode website) ──► Cloudflare ──► tampilkan dashboard HTML
Supabase Edge Function ──(pg_cron)──► tarik API luar ──► monitoring.* (DB) ──► chart/EWS
```

## Fungsi yang LIVE (deployed di Supabase)

| Fungsi | Jadwal (pg_cron) | Sumber data | Tujuan |
|---|---|---|---|
| `pull-argatech-sensors` | tiap 2 menit (`pull-argatech-2min`) | Argatech API (device 372, 373) | Extensometer + AWS/cuaca |
| `pull-loadsensing` | tiap 15 menit (`pull-loadsensing-hourly`) | Loadsensing/Worldsensing | Inclinometer + VWP |
| `fetch-bmkg` | **tiap 1 menit** (`fetch-bmkg-every-minute`) | BMKG realtime (scrape) | Gempa → PGA/TARP → **picu WhatsApp** |
| `send-alert-wa` | dipanggil oleh `fetch-bmkg` saat ada alert | — | Notifikasi WhatsApp |
| `send-alert-email` | on-demand | — | Notifikasi email |

> `fetch-bmkg` **harus tetap per-menit**: saat ada gempa baru melewati ambang, ia
> langsung memanggil `send-alert-wa`. Menurunkan frekuensi = notifikasi telat (bukan
> early-warning lagi). Dedup via `event_id`, jadi polling per-menit tidak menumpuk duplikat.

## Job pg_cron terkait (di database)
- `pull-argatech-2min`, `pull-loadsensing-hourly`, `fetch-bmkg-every-minute` — pemicu pull.
- `ews-evaluate-10min` → `monitoring.evaluate_ews()` — hitung TARP/EWS tiap 10 menit.
- `prune-ingestion-logs` → `monitoring.prune_ingestion_logs(7)` — bersih log audit harian.

## Jalur ingest ke `readings`
- `pull-*` menyimpan respons mentah ke `monitoring.ingestion_batches` + `raw_api_payloads`.
- Fungsi DB `ingest_loadsensing_payload` / `parse_raw_payload` mem-parse ke
  `monitoring.readings` dengan dedup `ON CONFLICT (sensor_id, ts) DO NOTHING` (idempoten).

## Catatan repo
- `pull-fortuna-aws/` = **ORPHAN** — tidak ada di Supabase (digantikan `pull-argatech-sensors`).
  Disimpan hanya sebagai riwayat; jangan dianggap aktif.
- Secrets (API key Argatech, dll.) **tidak** ada di kode — diambil via `Deno.env.get(...)`
  dari environment Supabase. Jangan pernah commit secret ke repo ini.

## Cara mengambil ulang source dari Supabase (kalau perlu sinkron)
Gunakan Supabase CLI: `supabase functions download <slug>` (atau dashboard → Edge Functions).
