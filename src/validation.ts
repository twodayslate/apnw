export const MAX_BODY_BYTES = 8_192;

const RANDOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN_PATTERN = /^(?:[0-9a-fA-F]{2}){1,256}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1_000;
const MAX_EVENT_FUTURE_MS = 5 * 60 * 1_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function requireInstallationID(value: string): string {
  if (!isCanonicalRandomID(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value;
}

export function requireDeviceToken(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_TOKEN_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value.toLowerCase();
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.includes(",") || !UUID_V4_PATTERN.test(key)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return key;
}

export function requireEventCreatedAt(
  request: Request,
  now = Date.now(),
): number {
  const raw = request.headers.get("event-created-at");
  const match = raw?.match(RFC3339_PATTERN);
  if (
    raw === null ||
    raw.includes(",") ||
    !match ||
    !hasValidRFC3339Fields(match)
  ) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  const timestamp = Date.parse(raw);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < now - MAX_EVENT_AGE_MS ||
    timestamp > now + MAX_EVENT_FUTURE_MS
  ) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return timestamp;
}

function hasValidRFC3339Fields(match: RegExpMatchArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

export async function readJsonObject(
  request: Request,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }
  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader === null ? undefined : Number(declaredLengthHeader);
  if (
    declaredLength !== undefined &&
    (!Number.isInteger(declaredLength) || declaredLength < 0)
  ) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  if (declaredLength !== undefined && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request_too_large", "Request too large");
  }

  const text = await readLimitedText(request);
  if (hasDuplicateJsonObjectKey(text)) {
    throw new HttpError(400, "invalid_json", "Invalid JSON");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON");
  }
  if (!isObject(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value;
}

export function requireBase64(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > maximumBytes * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
      throw new Error("size");
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (btoa(binary) !== value) throw new Error("canonical");
    return bytes;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
}

export function requireRandomID(value: unknown): string {
  if (typeof value !== "string" || !isCanonicalRandomID(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value;
}

export function emptyBodyOnly(request: Request): void {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 0 || request.body !== null) {
    throw new HttpError(400, "invalid_request", "Request body is not allowed");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLimitedText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "request_too_large", "Request too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON");
  }
}

function isCanonicalRandomID(value: string): boolean {
  if (!RANDOM_ID_PATTERN.test(value)) return false;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const bytes = Uint8Array.from(atob(normalized), (character) =>
      character.charCodeAt(0),
    );
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    return bytes.byteLength === 32 && encoded === value;
  } catch {
    return false;
  }
}

/**
 * JSON.parse accepts duplicate object member names and silently keeps the last
 * one. This bounded scanner rejects duplicates at every nesting level before
 * parsing, including escaped spellings of the same key.
 */
function hasDuplicateJsonObjectKey(text: string): boolean {
  const stack: Array<{
    kind: "array" | "object";
    keys?: Set<string>;
    expectingKey?: boolean;
  }> = [];
  let index = 0;
  let pendingString: string | undefined;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character ?? "")) {
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        if (!escaped && current === '"') break;
        escaped = !escaped && current === "\\";
        if (current !== "\\") escaped = false;
        index += 1;
      }
      if (index >= text.length) return false;
      try {
        pendingString = JSON.parse(text.slice(start, index + 1)) as string;
      } catch {
        return false;
      }
      const object = stack.at(-1);
      if (object?.kind === "object" && object.expectingKey) {
        let cursor = index + 1;
        while (/\s/.test(text[cursor] ?? "")) cursor += 1;
        if (text[cursor] === ":") {
          if (object.keys?.has(pendingString)) return true;
          object.keys?.add(pendingString);
          object.expectingKey = false;
        }
      }
      index += 1;
      continue;
    }
    pendingString = undefined;
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set(), expectingKey: true });
    } else if (character === "[") {
      stack.push({ kind: "array" });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const container = stack.at(-1);
      if (container?.kind === "object") container.expectingKey = true;
    }
    index += 1;
  }
  return false;
}
