import { HttpError } from "./validation";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_VALUES = 512;

export function requireEventName(value: unknown): string {
  if (typeof value !== "string" || !EVENT_NAME_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value;
}

export function requireEventData(value: unknown): {
  data: JsonObject;
  dataJSON: string;
} {
  const data = value === undefined ? {} : value;
  if (!isJsonObject(data)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  const remaining = { values: MAX_JSON_VALUES };
  validateJson(data, 0, remaining);
  const dataJSON = JSON.stringify(sortJson(data));
  return { data: JSON.parse(dataJSON) as JsonObject, dataJSON };
}

export function parseStoredEventData(dataJSON: string): JsonObject {
  try {
    return requireEventData(JSON.parse(dataJSON)).data;
  } catch {
    throw new Error("Stored event data is invalid");
  }
}

function validateJson(
  value: JsonValue,
  depth: number,
  remaining: { values: number },
): void {
  remaining.values -= 1;
  if (remaining.values < 0 || depth > MAX_JSON_DEPTH) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1, remaining);
    return;
  }
  if (isJsonObject(value)) {
    for (const item of Object.values(value)) {
      validateJson(item, depth + 1, remaining);
    }
  }
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonObject(value)) return value;
  const sorted: JsonObject = Object.create(null) as JsonObject;
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) sorted[key] = sortJson(item);
  }
  return sorted;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
