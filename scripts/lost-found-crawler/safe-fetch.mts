import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const USER_AGENT =
  "Berlin-Lost-Found-Channel-Research/1.0";
const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 2_000_000;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) !== 4 || isPrivateIpv4(mapped);
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

export function isForbiddenIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost")
  ) {
    throw new Error(`Refusing unsafe URL: ${rawUrl}`);
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenIp(address))) {
    throw new Error(`Refusing non-public destination: ${url.hostname}`);
  }
  return url;
}

async function resolvePublicHttpUrl(
  rawUrl: string
): Promise<{
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}> {
  const url = await assertPublicHttpUrl(rawUrl);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.filter(
    (entry): entry is { address: string; family: 4 | 6 } =>
      (entry.family === 4 || entry.family === 6) && !isForbiddenIp(entry.address)
  );
  publicAddresses.sort((left, right) => left.family - right.family);
  if (
    !publicAddresses.length ||
    publicAddresses.length !== addresses.length
  ) {
    throw new Error(`Refusing non-public destination: ${url.hostname}`);
  }
  return { url, addresses: publicAddresses };
}

async function readBoundedBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  maxBytes: number
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export interface SafeFetchBytesResult {
  url: string;
  status: number;
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

async function fetchPublicBytes(
  rawUrl: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
  } = {}
): Promise<SafeFetchBytesResult> {
  let current = await assertPublicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const resolved = await resolvePublicHttpUrl(current.toString());
    const pinned = resolved.addresses[0];
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          if (typeof _options === "object" && _options?.all) {
            callback(null, [pinned]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      },
    });
    try {
      const response = await undiciFetch(current, {
        method: "GET",
        redirect: "manual",
        dispatcher,
        headers: {
          accept: options.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.8",
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error(`Redirect without Location from ${current}`);
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      return {
        url: current.toString(),
        status: response.status,
        headers: response.headers,
        body: await readBoundedBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES),
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error(`Too many redirects from ${rawUrl}`);
}

export async function safeFetchBytes(
  rawUrl: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
  } = {}
): Promise<SafeFetchBytesResult> {
  return fetchPublicBytes(rawUrl, options);
}

export interface SafeFetchResult
  extends Omit<SafeFetchBytesResult, "body"> {
  body: string;
}

export async function safeFetchText(
  rawUrl: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
  } = {}
): Promise<SafeFetchResult> {
  const response = await fetchPublicBytes(rawUrl, options);
  return {
    ...response,
    body: new TextDecoder().decode(response.body),
  };
}
