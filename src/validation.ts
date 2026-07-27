export const MAX_BODY_BYTES = 8_192;
export const MAX_ROUTE_LENGTH = 1_024;
export const MAX_DEVICES_PER_CHANNEL = 40;

const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN_PATTERN = /^(?:[0-9a-fA-F]{2}){1,256}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+-]{1,128}$/;

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
  if (!INSTALLATION_ID_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value.toLowerCase();
}

export function requireDeviceToken(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_TOKEN_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value.toLowerCase();
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return key;
}

export function validateRoute(
  value: unknown,
  allowedSchemes: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_ROUTE_LENGTH) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  if (!allowedSchemes.includes(url.protocol.slice(0, -1).toLowerCase())) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value;
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
