import {
  isPublishedChannelRegistry,
  type PublishedChannelRegistry,
} from "../../lib/lost-found-channel-schema";
import {
  isPublicLostFoundResponsibilityIndex,
  type PublicLostFoundResponsibilityIndex,
} from "../../lib/lost-found-responsibility-schema";

export const LOST_FOUND_DATA_MANIFEST_URL =
  "https://yulid.org/berlin-lost-found/v1/manifest.json";

const CACHE_KEY = "berlin-lostfound-remote-data-v1";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_VERIFIED_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface RemoteResource {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RemoteDataManifest {
  version: 1;
  datasetVersion: string;
  generatedAt: string;
  publishedAt: string;
  resources: {
    channels: RemoteResource;
    responsibilities: RemoteResource;
  };
  summary?: {
    channels?: number;
    reviewedVenues?: number;
    totalVenues?: number;
    fillOnlyAdapters?: number;
    reviewedSubmitAdapters?: number;
  };
}

export interface RemoteLostFoundData {
  manifest: RemoteDataManifest;
  channels: PublishedChannelRegistry;
  responsibilities: PublicLostFoundResponsibilityIndex;
  source: "remote" | "cache";
  checkedAt: string;
  warning?: string;
}

interface CachedRemoteData {
  version: 1;
  sourceUrl: string;
  storedAt: string;
  manifest: RemoteDataManifest;
  channelText: string;
  responsibilityText: string;
}

type Fetcher = typeof fetch;

function validResource(value: unknown): value is RemoteResource {
  if (!value || typeof value !== "object") return false;
  const resource = value as Partial<RemoteResource>;
  return (
    typeof resource.path === "string" &&
    /^[a-z-]+\.json$/.test(resource.path) &&
    typeof resource.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(resource.sha256) &&
    typeof resource.bytes === "number" &&
    Number.isInteger(resource.bytes) &&
    resource.bytes > 0 &&
    resource.bytes <= MAX_RESOURCE_BYTES
  );
}

export function isRemoteDataManifest(
  value: unknown
): value is RemoteDataManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<RemoteDataManifest>;
  return (
    manifest.version === 1 &&
    typeof manifest.datasetVersion === "string" &&
    /^[a-f0-9]{16}$/.test(manifest.datasetVersion) &&
    typeof manifest.generatedAt === "string" &&
    Number.isFinite(Date.parse(manifest.generatedAt)) &&
    typeof manifest.publishedAt === "string" &&
    Number.isFinite(Date.parse(manifest.publishedAt)) &&
    Boolean(manifest.resources) &&
    validResource(manifest.resources?.channels) &&
    validResource(manifest.resources?.responsibilities)
  );
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This device cannot verify downloaded data.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function resourceUrl(manifestUrl: string, resource: RemoteResource): string {
  const manifest = new URL(manifestUrl);
  const basePath = manifest.pathname.slice(0, manifest.pathname.lastIndexOf("/") + 1);
  const resolved = new URL(resource.path, manifest);
  if (
    manifest.protocol !== "https:" ||
    resolved.origin !== manifest.origin ||
    !resolved.pathname.startsWith(basePath)
  ) {
    throw new Error("The data manifest contains an unsafe resource URL.");
  }
  return resolved.toString();
}

async function fetchText(
  fetcher: Fetcher,
  url: string,
  expected: RemoteResource,
  signal: AbortSignal
): Promise<string> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`Data request failed (HTTP ${response.status}).`);
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESOURCE_BYTES) {
    throw new Error("The downloaded data is larger than the app safety limit.");
  }
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes !== expected.bytes || bytes > MAX_RESOURCE_BYTES) {
    throw new Error("The downloaded data size does not match its manifest.");
  }
  if ((await sha256(text)) !== expected.sha256) {
    throw new Error("The downloaded data failed its integrity check.");
  }
  return text;
}

function parseBundle(
  manifest: RemoteDataManifest,
  channelText: string,
  responsibilityText: string
) {
  const channels = JSON.parse(channelText) as unknown;
  const responsibilities = JSON.parse(responsibilityText) as unknown;
  if (!isPublishedChannelRegistry(channels)) {
    throw new Error("The downloaded channel registry has an unsupported schema.");
  }
  if (!isPublicLostFoundResponsibilityIndex(responsibilities)) {
    throw new Error("The downloaded responsibility index has an unsupported schema.");
  }
  const newestResourceDate =
    channels.generatedAt > responsibilities.generatedAt
      ? channels.generatedAt
      : responsibilities.generatedAt;
  if (manifest.generatedAt !== newestResourceDate) {
    throw new Error("The data manifest and its resources describe different versions.");
  }
  return { channels, responsibilities };
}

function writeCache(value: CachedRemoteData): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // A valid network response remains usable when private mode blocks storage.
  }
}

export async function fetchRemoteLostFoundData(options: {
  manifestUrl?: string;
  fetcher?: Fetcher;
  now?: Date;
} = {}): Promise<RemoteLostFoundData> {
  const manifestUrl = options.manifestUrl ?? LOST_FOUND_DATA_MANIFEST_URL;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(manifestUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Data manifest failed (HTTP ${response.status}).`);
    }
    const manifest = (await response.json()) as unknown;
    if (!isRemoteDataManifest(manifest)) {
      throw new Error("The data manifest has an unsupported schema.");
    }
    const [channelText, responsibilityText] = await Promise.all([
      fetchText(
        fetcher,
        resourceUrl(manifestUrl, manifest.resources.channels),
        manifest.resources.channels,
        controller.signal
      ),
      fetchText(
        fetcher,
        resourceUrl(manifestUrl, manifest.resources.responsibilities),
        manifest.resources.responsibilities,
        controller.signal
      ),
    ]);
    const parsed = parseBundle(manifest, channelText, responsibilityText);
    const checkedAt = (options.now ?? new Date()).toISOString();
    writeCache({
      version: 1,
      sourceUrl: manifestUrl,
      storedAt: checkedAt,
      manifest,
      channelText,
      responsibilityText,
    });
    return { manifest, ...parsed, source: "remote", checkedAt };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function readCachedLostFoundData(options: {
  manifestUrl?: string;
  now?: Date;
  storage?: Pick<Storage, "getItem">;
} = {}): Promise<RemoteLostFoundData | null> {
  const storage =
    options.storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedRemoteData>;
    if (
      cached.version !== 1 ||
      cached.sourceUrl !== (options.manifestUrl ?? LOST_FOUND_DATA_MANIFEST_URL) ||
      !isRemoteDataManifest(cached.manifest) ||
      typeof cached.channelText !== "string" ||
      typeof cached.responsibilityText !== "string"
    ) {
      return null;
    }
    const now = options.now ?? new Date();
    const storedAt = Date.parse(cached.storedAt ?? "");
    if (
      !Number.isFinite(storedAt) ||
      storedAt > now.getTime() + 5 * 60 * 1000 ||
      now.getTime() - storedAt > MAX_VERIFIED_CACHE_AGE_MS
    ) {
      return null;
    }
    const [channelHash, responsibilityHash] = await Promise.all([
      sha256(cached.channelText),
      sha256(cached.responsibilityText),
    ]);
    if (
      channelHash !== cached.manifest.resources.channels.sha256 ||
      responsibilityHash !== cached.manifest.resources.responsibilities.sha256
    ) {
      return null;
    }
    const parsed = parseBundle(
      cached.manifest,
      cached.channelText,
      cached.responsibilityText
    );
    return {
      manifest: cached.manifest,
      ...parsed,
      source: "cache",
      checkedAt: now.toISOString(),
      warning: "The update server was unavailable; using the last verified download.",
    };
  } catch {
    return null;
  }
}
