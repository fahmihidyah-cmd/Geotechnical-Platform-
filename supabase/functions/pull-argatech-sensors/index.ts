import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type DeviceRow = {
  id: string;
  external_device_id: string;
  device_name: string | null;
  category: "extensometer" | "aws_vaisala" | "other";
  is_active: boolean;
  pull_enabled: boolean;
};

type RequestPayload = {
  deviceIds?: string[];
  dryRun?: boolean;
  includeInactive?: boolean;
};

const DEFAULT_DEVICE_IDS = ["372", "373"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizePayload(payload: unknown) {
  if (payload === null || payload === undefined) {
    return {};
  }
  if (typeof payload === "string") {
    return { raw_text: payload };
  }
  return payload;
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function tryParseDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function findObservedAt(payload: unknown): string | null {
  const candidateKeys = [
    "observed_at",
    "observedAt",
    "timestamp",
    "time",
    "datetime",
    "date_time",
    "measured_at",
    "measuredAt",
    "created_at",
    "createdAt",
  ];

  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 4 || value === null || value === undefined) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;

      for (const key of candidateKeys) {
        if (key in obj) {
          const parsed = tryParseDate(obj[key]);
          if (parsed) return parsed;
        }
      }

      for (const nestedValue of Object.values(obj)) {
        const found = visit(nestedValue, depth + 1);
        if (found) return found;
      }
    }

    return null;
  };

  return visit(payload, 0);
}

function detectPayloadType(category: DeviceRow["category"], payload: unknown): string {
  if (category === "extensometer") return "extensometer";
  if (category === "aws_vaisala") return "aws_vaisala";

  if (payload && typeof payload === "object") {
    const raw = JSON.stringify(payload).toLowerCase();
    if (raw.includes("vaisala") || raw.includes("humidity") || raw.includes("rainfall")) {
      return "aws_vaisala";
    }
    if (raw.includes("extensometer") || raw.includes("displacement")) {
      return "extensometer";
    }
  }

  return "sensor-by-device";
}

async function readRequestPayload(req: Request): Promise<RequestPayload> {
  if (req.method === "GET") {
    return {};
  }

  try {
    return (await req.json()) as RequestPayload;
  } catch {
    return {};
  }
}

function normalizeRequestedDeviceIds(payload: RequestPayload): string[] {
  const requestedIds = Array.isArray(payload.deviceIds)
    ? payload.deviceIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  return requestedIds.length > 0 ? requestedIds : DEFAULT_DEVICE_IDS;
}

async function getTargetDevices(
  supabase: ReturnType<typeof createClient>,
  payload: RequestPayload,
): Promise<DeviceRow[]> {
  const requestedDeviceIds = normalizeRequestedDeviceIds(payload);

  let query = supabase
    .schema("monitoring")
    .from("devices")
    .select("id, external_device_id, device_name, category, is_active, pull_enabled")
    .eq("pull_enabled", true)
    .in("external_device_id", requestedDeviceIds)
    .order("external_device_id", { ascending: true });

  if (!payload.includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Gagal membaca daftar device: ${error.message}`);
  }

  return (data ?? []) as DeviceRow[];
}

async function insertBatch(
  supabase: ReturnType<typeof createClient>,
  batch: {
    endpoint: string;
    requested_device_id: string;
    http_status: number;
    success: boolean;
    error_message: string | null;
    response_content_type: string | null;
    response_payload: unknown;
  },
) {
  const { data, error } = await supabase
    .schema("monitoring")
    .from("ingestion_batches")
    .insert(batch)
    .select("id")
    .single();

  if (error) {
    throw new Error(`Gagal menyimpan ingestion batch: ${error.message}`);
  }

  return data.id as string;
}

async function updateDevicePullStatus(
  supabase: ReturnType<typeof createClient>,
  device: DeviceRow,
  patch: Record<string, unknown>,
) {
  const { error } = await supabase
    .schema("monitoring")
    .from("devices")
    .update(patch)
    .eq("id", device.id);

  if (error) {
    console.error(
      `Gagal update status device ${device.external_device_id}: ${error.message}`,
    );
  }
}

async function rawPayloadExists(
  supabase: ReturnType<typeof createClient>,
  deviceId: string,
  payloadHash: string,
) {
  const { data, error } = await supabase
    .schema("monitoring")
    .from("raw_api_payloads")
    .select("id")
    .eq("device_id", deviceId)
    .eq("payload_hash", payloadHash)
    .limit(1);

  if (error) {
    throw new Error(`Gagal cek payload duplikat: ${error.message}`);
  }

  return (data ?? []).length > 0;
}

async function insertRawPayload(
  supabase: ReturnType<typeof createClient>,
  rawPayload: {
    batch_id: string;
    device_id: string;
    payload_type: string;
    payload: unknown;
    observed_at: string | null;
    payload_hash: string;
  },
) {
  const duplicate = await rawPayloadExists(
    supabase,
    rawPayload.device_id,
    rawPayload.payload_hash,
  );
  if (duplicate) {
    return { inserted: false };
  }

  const { error } = await supabase
    .schema("monitoring")
    .from("raw_api_payloads")
    .insert(rawPayload);

  if (error) {
    throw new Error(`Gagal menyimpan raw payload: ${error.message}`);
  }

  return { inserted: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ARGATECH_API_BASE_URL = Deno.env.get("ARGATECH_API_BASE_URL") ??
      "https://ews.argatech.com/api/sensor-by-device";
    const ARGATECH_API_KEY = Deno.env.get("ARGATECH_API_KEY");
    const ARGATECH_API_SIGNATURE = Deno.env.get("ARGATECH_API_SIGNATURE");
    const ARGATECH_API_VERSION = Deno.env.get("ARGATECH_API_VERSION") ?? "2";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse(500, {
        error: true,
        message: "Environment Supabase belum lengkap.",
      });
    }

    if (!ARGATECH_API_KEY || !ARGATECH_API_SIGNATURE) {
      return jsonResponse(500, {
        error: true,
        message: "Secret Argatech belum lengkap.",
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const payload = await readRequestPayload(req);
    const includeInactive = payload.includeInactive ?? false;
    const dryRun = payload.dryRun ?? false;
    const requestedDeviceIds = normalizeRequestedDeviceIds(payload);
    const devices = await getTargetDevices(supabase, {
      ...payload,
      includeInactive,
      deviceIds: requestedDeviceIds,
    });

    if (devices.length === 0) {
      return jsonResponse(400, {
        error: true,
        message:
          "Device target tidak ditemukan atau tidak aktif. Pastikan device 372 dan 373 tersedia di tabel monitoring.devices dan pull_enabled = true.",
        requestedDeviceIds,
      });
    }

    const results = [];

    for (const device of devices) {
      const endpoint =
        `${ARGATECH_API_BASE_URL}?deviceId=${encodeURIComponent(device.external_device_id)}`;
      const startedAt = new Date().toISOString();

      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            "Api-key": ARGATECH_API_KEY,
            "Api-signature": ARGATECH_API_SIGNATURE,
            "Api-version": ARGATECH_API_VERSION,
          },
        });

        const responseText = await response.text();
        const parsedPayload = safeJsonParse(responseText);
        const jsonPayload = sanitizePayload(parsedPayload ?? responseText);
        const contentType = response.headers.get("content-type");
        const observedAt = findObservedAt(jsonPayload);
        const payloadType = detectPayloadType(device.category, jsonPayload);
        const payloadHash = await sha256(responseText);

        if (dryRun) {
          results.push({
            deviceId: device.external_device_id,
            deviceName: device.device_name,
            httpStatus: response.status,
            success: response.ok,
            observedAt,
            payloadType,
            duplicate: false,
            dryRun: true,
          });
          continue;
        }

        const errorMessage = response.ok
          ? null
          : typeof jsonPayload === "object" &&
              jsonPayload &&
              "message" in (jsonPayload as Record<string, unknown>)
          ? String((jsonPayload as Record<string, unknown>).message)
          : "Request gagal";

        const batchId = await insertBatch(supabase, {
          endpoint,
          requested_device_id: device.external_device_id,
          http_status: response.status,
          success: response.ok,
          error_message: errorMessage,
          response_content_type: contentType,
          response_payload: jsonPayload,
        });

        let duplicate = false;
        if (response.ok) {
          const rawInsert = await insertRawPayload(supabase, {
            batch_id: batchId,
            device_id: device.id,
            payload_type: payloadType,
            payload: jsonPayload,
            observed_at: observedAt,
            payload_hash: payloadHash,
          });

          duplicate = !rawInsert.inserted;
        }

        await updateDevicePullStatus(supabase, device, {
          last_pull_at: startedAt,
          last_pull_status: response.ok ? "success" : "failed",
          last_pull_error: errorMessage,
          last_seen_at: response.ok ? (observedAt ?? startedAt) : null,
          status: response.ok ? "online" : "warning",
        });

        results.push({
          deviceId: device.external_device_id,
          deviceName: device.device_name,
          httpStatus: response.status,
          success: response.ok,
          observedAt,
          payloadType,
          duplicate,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";

        if (!dryRun) {
          await updateDevicePullStatus(supabase, device, {
            last_pull_at: startedAt,
            last_pull_status: "failed",
            last_pull_error: message,
            status: "warning",
          });

          await insertBatch(supabase, {
            endpoint,
            requested_device_id: device.external_device_id,
            http_status: 0,
            success: false,
            error_message: message,
            response_content_type: null,
            response_payload: { error: true, message },
          });
        }

        results.push({
          deviceId: device.external_device_id,
          deviceName: device.device_name,
          httpStatus: 0,
          success: false,
          error: message,
        });
      }
    }

    const okCount = results.filter((item) => item.success).length;
    const failCount = results.length - okCount;

    return jsonResponse(200, {
      error: false,
      dryRun,
      requestedDeviceIds,
      totalDevices: results.length,
      okCount,
      failCount,
      results,
    });
  } catch (error) {
    return jsonResponse(500, {
      error: true,
      message: error instanceof Error ? error.message : "Unhandled error",
    });
  }
});
