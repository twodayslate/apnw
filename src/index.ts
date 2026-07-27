import { getApp } from "./apps";
import {
  AuthenticationError,
  channelReference,
  deriveChannelName,
  readCapability,
} from "./auth";
import { buildPayload } from "./apns/payload";
import { ChannelObject } from "./channel/ChannelObject";
import {
  writeApnsReasonMetrics,
  writeMetric,
} from "./observability/analytics";
import {
  parseSampleRate,
  writeCompletionLog,
  type LogDetails,
} from "./observability/logger";
import type { Env, RequestContext } from "./types";
import {
  emptyBodyOnly,
  HttpError,
  readJsonObject,
  requireDeviceToken,
  requireIdempotencyKey,
  requireInstallationID,
  validateRoute,
} from "./validation";

export { ChannelObject };

interface Completed {
  response: Response;
  details: LogDetails;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const context: RequestContext = {
      colo:
        typeof request.cf?.colo === "string" ? request.cf.colo : undefined,
      deployment: env.APNS_ENVIRONMENT,
      operation: "not_found",
      requestID: crypto.randomUUID(),
      serviceVersion: env.SERVICE_VERSION,
      startedAt: Date.now(),
    };

    let completed: Completed;
    try {
      completed = await route(request, env, context);
    } catch (error) {
      completed = handleError(error);
    }

    writeCompletionLog(
      context,
      completed.details,
      parseSampleRate(env.LOG_SAMPLE_RATE),
    );
    writeMetric(env, context, {
      outcome: completed.details.outcome,
      httpStatus: completed.details.httpStatus,
      ...(completed.details.event
        ? { event: completed.details.event }
        : {}),
      ...(completed.details.apnsReason
        ? { apnsReason: completed.details.apnsReason }
        : {}),
      ...(completed.details.idempotency
        ? { idempotency: completed.details.idempotency }
        : {}),
      targetCount: completed.details.targetCount,
      acceptedCount: completed.details.acceptedCount,
      failedCount: completed.details.failedCount,
      invalidTokenRemovalCount:
        completed.details.invalidTokenRemovalCount,
      apnsLatencyTotalMs: completed.details.apnsLatencyTotalMs,
      apnsLatencyMaxMs: completed.details.apnsLatencyMaxMs,
      registrationDelta:
        completed.details.operationDelta,
      tokenReplacementCount:
        completed.details.tokenReplacementCount,
    });
    writeApnsReasonMetrics(
      env,
      context,
      completed.details.apnsReasonCounts,
    );
    return withSecurityHeaders(completed.response, context.requestID);
  },
};

async function route(
  request: Request,
  env: Env,
  context: RequestContext,
): Promise<Completed> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    context.operation = "health";
    return ok(
      {
        status: "ok",
        environment: env.APNS_ENVIRONMENT,
        version: env.SERVICE_VERSION,
      },
      { outcome: "healthy", httpStatus: 200 },
    );
  }

  const deviceMatch = url.pathname.match(
    /^\/v1\/apps\/([a-z0-9_]+)\/devices\/([^/]+)$/,
  );
  const eventMatch = url.pathname.match(
    /^\/v1\/apps\/([a-z0-9_]+)\/events$/,
  );
  const channelMatch = url.pathname.match(
    /^\/v1\/apps\/([a-z0-9_]+)\/channel$/,
  );
  const appID = deviceMatch?.[1] ?? eventMatch?.[1] ?? channelMatch?.[1];
  if (!appID) throw new HttpError(404, "not_found", "Not found");
  const app = getApp(appID);
  if (!app) throw new HttpError(404, "not_found", "Not found");
  context.appID = appID;

  const capability = readCapability(request);
  const channelName = await deriveChannelName(
    env.CHANNEL_HMAC_KEY,
    appID,
    capability,
  );
  context.channelRef = channelReference(channelName);
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(channelName));

  if (deviceMatch && request.method === "PUT") {
    context.operation = "register";
    const installationID = requireInstallationID(
      deviceMatch[2] ?? "",
    );
    const body = await readJsonObject(request, ["deviceToken"]);
    const deviceToken = requireDeviceToken(body.deviceToken);
    const result = await stub.registerDevice(installationID, deviceToken);
    if (!result.ok) return mutationFailure(result);
    const status = result.created ? 201 : 200;
    return ok(
      { registered: true },
      {
        outcome: result.created
          ? "registered"
          : result.tokenReplaced
            ? "token_replaced"
            : "already_registered",
        httpStatus: status,
        operationDelta: result.registrationDelta,
        tokenReplacementCount: result.tokenReplaced ? 1 : 0,
      },
      status,
    );
  }

  if (deviceMatch && request.method === "DELETE") {
    context.operation = "unregister";
    emptyBodyOnly(request);
    const installationID = requireInstallationID(
      deviceMatch[2] ?? "",
    );
    const result = await stub.unregisterDevice(installationID);
    if (!result.ok) return mutationFailure(result);
    return ok(
      { unregistered: true },
      {
        outcome: result.removed ? "unregistered" : "already_unregistered",
        httpStatus: 200,
        operationDelta: result.registrationDelta,
      },
    );
  }

  if (eventMatch && request.method === "POST") {
    context.operation = "publish";
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonObject(request, [
      "event",
      "excludeInstallationID",
      "route",
    ]);
    if (typeof body.event !== "string") {
      throw new HttpError(400, "invalid_request", "Invalid request");
    }
    const excludeInstallationID =
      body.excludeInstallationID === undefined
        ? undefined
        : requireInstallationID(String(body.excludeInstallationID));
    const routeValue = validateRoute(body.route, app.routeSchemes);
    const payload = buildPayload(app, body.event, routeValue);
    const fingerprint = await requestFingerprint(
      body.event,
      excludeInstallationID,
      routeValue,
    );
    const result = await stub.publish({
      app,
      event: body.event,
      ...(excludeInstallationID ? { excludeInstallationID } : {}),
      fingerprint,
      idempotencyKey,
      payload,
    });
    if (!result.ok) return mutationFailure(result);
    const status = result.retryable ? 503 : 200;
    return ok(
      {
        eventID: idempotencyKey,
        deviceCount: result.deviceCount,
        accepted: result.accepted,
        failed: result.failed,
        retryable: result.retryable,
      },
      {
        outcome: result.retryable ? "partial_failure" : "accepted",
        httpStatus: status,
        event: body.event,
        targetCount: result.deviceCount,
        acceptedCount: result.accepted,
        failedCount: result.failed,
        invalidTokenRemovalCount: result.invalidRemoved,
        idempotency: result.idempotency,
        apnsReason: result.apnsReason,
        apnsReasonCounts: result.apnsReasonCounts,
        apnsStatus: result.apnsStatus,
        ...(result.apnsRequestID
          ? { apnsRequestID: result.apnsRequestID }
          : {}),
        apnsLatencyTotalMs: result.apnsLatencyTotalMs,
        apnsLatencyMaxMs: result.apnsLatencyMaxMs,
      },
      status,
      result.retryable ? { "retry-after": "2" } : undefined,
    );
  }

  if (channelMatch && request.method === "DELETE") {
    context.operation = "close_channel";
    emptyBodyOnly(request);
    const result = await stub.closeChannel();
    if (!result.ok) return mutationFailure(result);
    return ok(
      { closed: true },
      {
        outcome: result.alreadyClosed ? "already_closed" : "closed",
        httpStatus: 200,
        operationDelta: result.alreadyClosed ? 0 : 1,
      },
    );
  }

  throw new HttpError(404, "not_found", "Not found");
}

function mutationFailure(
  result:
    | { ok: false; code: "closed" }
    | { ok: false; code: "rate_limited"; retryAfter: number }
    | { ok: false; code: "channel_full" }
    | { ok: false; code: "idempotency_conflict" },
): Completed {
  switch (result.code) {
    case "rate_limited":
      return error(
        429,
        "rate_limited",
        "Too many requests",
        "rate_limited",
        { "retry-after": String(result.retryAfter) },
      );
    case "channel_full":
      return error(409, "channel_full", "Channel is full", "channel_full");
    case "idempotency_conflict":
      return error(
        409,
        "idempotency_conflict",
        "Idempotency key was already used",
        "idempotency_conflict",
      );
    case "closed":
      return error(404, "not_found", "Not found", "closed");
  }
}

function handleError(value: unknown): Completed {
  if (value instanceof AuthenticationError) {
    return error(404, "not_found", "Not found", "authentication_rejected");
  }
  if (value instanceof HttpError) {
    return error(
      value.status,
      value.code,
      value.message,
      value.status === 404 ? "not_found" : "validation_rejected",
      value.retryAfter
        ? { "retry-after": String(value.retryAfter) }
        : undefined,
    );
  }
  return error(500, "internal_error", "Internal error", "internal_error");
}

function ok(
  body: object,
  details: LogDetails,
  status = 200,
  headers?: Record<string, string>,
): Completed {
  return {
    response: json(body, status, headers),
    details,
  };
}

function error(
  status: number,
  code: string,
  message: string,
  outcome: string,
  headers?: Record<string, string>,
): Completed {
  return {
    response: json({ error: { code, message } }, status, headers),
    details: { outcome, httpStatus: status },
  };
}

function json(
  value: object,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function withSecurityHeaders(response: Response, requestID: string): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("cache-control", "no-store");
  wrapped.headers.set("referrer-policy", "no-referrer");
  wrapped.headers.set("x-content-type-options", "nosniff");
  wrapped.headers.set("x-request-id", requestID);
  return wrapped;
}

async function requestFingerprint(
  event: string,
  excludeInstallationID?: string,
  route?: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([event, excludeInstallationID ?? null, route ?? null]),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
