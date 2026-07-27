import type { AppConfig } from "../apps";
import { HttpError } from "../validation";

export interface ApnsPayload {
  aps: {
    alert: {
      title: string;
      body: string;
    };
    sound: "default";
  };
  route?: string;
}

export function buildPayload(
  app: AppConfig,
  event: string,
  route?: string,
): ApnsPayload {
  const template = app.templates[event];
  if (!template) {
    throw new HttpError(404, "not_found", "Not found");
  }
  const payload: ApnsPayload = {
    aps: {
      alert: {
        title: template.title,
        body: template.body,
      },
      sound: "default",
    },
    ...(route ? { route } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 4_096) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return payload;
}
