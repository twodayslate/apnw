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
}

export function buildPayload(app: AppConfig, event: string): ApnsPayload {
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
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 4_096) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return payload;
}
