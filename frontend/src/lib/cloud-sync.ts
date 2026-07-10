/**
 * Cross-device vault sync via Google Drive App Data folder.
 *
 * Secrets never go to a third-party backend we run — only Google Drive
 * private appData (visible only to this OAuth app + the signed-in account).
 * Payload is AES-256-GCM encrypted; DEK lives in the same private file
 * (account-bound confidentiality).
 */

import {
  type EncryptedBlob,
  b64decode,
  b64encode,
  decryptJson,
  encryptJson,
  generateExtractableKey,
  randomBytes,
} from "./crypto";
import {
  ensureGoogleToken,
  getGoogleUser,
  isGoogleSignedIn,
} from "./google-auth";
import type { KaggleSecret } from "./vault";
import type { StoredPrefs } from "./vault";

const FILE_NAME = "edgerunner-sync-v1.json";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export type CloudSyncPayload = {
  v: 1;
  updatedAt: number;
  secret?: KaggleSecret | null;
  prefs?: StoredPrefs | null;
  /** Optional last chat snapshot (may be large — kept small) */
  chat?: {
    id: string;
    messages: { role: string; content: string; ts?: number }[];
    updated_at: number;
  } | null;
};

type CloudFileEnvelope = {
  v: 1;
  /** base64 raw AES-256 key */
  dek: string;
  blob: EncryptedBlob;
  updatedAt: number;
  email?: string;
};

let cachedFileId: string | null = null;

async function authHeaders(): Promise<HeadersInit> {
  const token = await ensureGoogleToken();
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function findFileId(): Promise<string | null> {
  if (cachedFileId) return cachedFileId;
  const headers = await authHeaders();
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const res = await fetch(
    `${DRIVE_API}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
    { headers, cache: "no-store" }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive list failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { files?: { id: string }[] };
  const id = data.files?.[0]?.id || null;
  cachedFileId = id;
  return id;
}

async function downloadEnvelope(
  fileId: string
): Promise<CloudFileEnvelope | null> {
  const headers = await authHeaders();
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers,
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive download failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as CloudFileEnvelope;
}

async function importDek(b64: string): Promise<CryptoKey> {
  const raw = b64decode(b64);
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function createEnvelope(
  payload: CloudSyncPayload
): Promise<CloudFileEnvelope> {
  const dek = await generateExtractableKey();
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", dek));
  const sessionKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const blob = await encryptJson(sessionKey, payload);
  const user = getGoogleUser();
  return {
    v: 1,
    dek: b64encode(raw),
    blob,
    updatedAt: payload.updatedAt,
    email: user?.email,
  };
}

async function decryptEnvelope(
  env: CloudFileEnvelope
): Promise<CloudSyncPayload> {
  const key = await importDek(env.dek);
  return decryptJson<CloudSyncPayload>(key, env.blob);
}

async function uploadEnvelope(envelope: CloudFileEnvelope): Promise<void> {
  const headers = await authHeaders();
  const body = JSON.stringify(envelope);
  const existing = await findFileId();

  if (existing) {
    const res = await fetch(
      `${DRIVE_UPLOAD}/files/${existing}?uploadType=media`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body,
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Drive update failed (${res.status}): ${t.slice(0, 200)}`);
    }
    return;
  }

  // Create new file in appDataFolder (multipart)
  const metadata = {
    name: FILE_NAME,
    parents: ["appDataFolder"],
  };
  const boundary = "edgerunner_" + b64encode(randomBytes(8)).replace(/=/g, "");
  const multipart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${body}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipart,
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive create failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const created = (await res.json()) as { id?: string };
  if (created.id) cachedFileId = created.id;
}

/** Pull cloud payload (null if none). */
export async function pullCloudSync(): Promise<CloudSyncPayload | null> {
  if (!isGoogleSignedIn() && !(await ensureGoogleToken())) {
    return null;
  }
  const id = await findFileId();
  if (!id) return null;
  const env = await downloadEnvelope(id);
  if (!env?.blob || !env.dek) return null;
  return decryptEnvelope(env);
}

/** Push local secret/prefs to Drive app data. */
export async function pushCloudSync(payload: CloudSyncPayload): Promise<void> {
  await ensureGoogleToken();
  const full: CloudSyncPayload = {
    v: 1,
    updatedAt: payload.updatedAt || Date.now(),
    secret: payload.secret ?? null,
    prefs: payload.prefs ?? null,
    chat: payload.chat ?? null,
  };
  const envelope = await createEnvelope(full);
  await uploadEnvelope(envelope);
}

export function resetCloudFileCache(): void {
  cachedFileId = null;
}

/**
 * Merge cloud ↔ local after Google sign-in.
 * Returns what was applied for UI messaging.
 */
export async function syncAfterGoogleLogin(local: {
  secret: KaggleSecret | null;
  prefs: StoredPrefs;
  applySecret: (s: KaggleSecret) => Promise<void>;
  applyPrefs: (p: StoredPrefs) => void;
  getLocalUpdatedAt: () => number;
}): Promise<{ action: "pulled" | "pushed" | "merged" | "empty"; detail: string }> {
  let cloud: CloudSyncPayload | null = null;
  try {
    cloud = await pullCloudSync();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cloud pull failed: ${msg}`);
  }

  const localAt = local.getLocalUpdatedAt();
  const hasLocalSecret = !!(
    local.secret?.apiToken ||
    local.secret?.apiKey ||
    local.secret?.username
  );
  const hasCloudSecret = !!(
    cloud?.secret?.apiToken ||
    cloud?.secret?.apiKey ||
    cloud?.secret?.username
  );

  if (!cloud || (!hasCloudSecret && !cloud.prefs)) {
    if (hasLocalSecret || Object.keys(local.prefs).length) {
      await pushCloudSync({
        v: 1,
        updatedAt: Date.now(),
        secret: local.secret,
        prefs: local.prefs,
      });
      return {
        action: "pushed",
        detail: "Uploaded this device’s vault to your Google account",
      };
    }
    return {
      action: "empty",
      detail: "Signed in — save Kaggle credentials once; they’ll sync to all devices",
    };
  }

  const cloudAt = cloud.updatedAt || 0;

  // Prefer newer side for secrets
  if (hasCloudSecret && (!hasLocalSecret || cloudAt >= localAt)) {
    if (cloud.secret) await local.applySecret(cloud.secret);
    if (cloud.prefs) local.applyPrefs({ ...local.prefs, ...cloud.prefs });
    // If local had newer prefs-only bits, push merge
    if (hasLocalSecret && localAt > cloudAt) {
      await pushCloudSync({
        v: 1,
        updatedAt: Date.now(),
        secret: local.secret,
        prefs: { ...cloud.prefs, ...local.prefs },
      });
      return { action: "merged", detail: "Merged cloud credentials with local prefs" };
    }
    return {
      action: "pulled",
      detail: `Restored Kaggle credentials from Google (${cloud.secret?.username || "saved"})`,
    };
  }

  // Local wins — push
  await pushCloudSync({
    v: 1,
    updatedAt: Date.now(),
    secret: local.secret,
    prefs: local.prefs,
  });
  return {
    action: "pushed",
    detail: "Synced this device’s credentials up to Google",
  };
}
