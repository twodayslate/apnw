import type { AppConfig } from "../apps";
import type { JsonObject } from "../event";
import { HttpError } from "../validation";

export interface ApnsPayload {
  aps: {
    alert: {
      title: string;
      body: string;
    };
    sound: "default";
    "mutable-content": 1;
  };
  apnw: {
    version: 1;
    event: string;
    data: JsonObject;
  };
}

export function buildPayload(
  app: AppConfig,
  event: string,
  data: JsonObject,
): ApnsPayload {
  const payload: ApnsPayload = {
    aps: {
      alert: {
        title: app.notificationFallback.title,
        body: app.notificationFallback.body,
      },
      sound: "default",
      "mutable-content": 1,
    },
    apnw: {
      version: 1,
      event,
      data,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 4_096) {
    throw new HttpError(
      413,
      "payload_too_large",
      "Notification payload too large",
    );
  }
  return payload;
}
