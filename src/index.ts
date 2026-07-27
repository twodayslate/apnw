import { ProvisioningObject } from "./appattest/ProvisioningObject";
import {
  AppAttestVerificationError,
  normalizeAppAttestKeyID,
} from "./appattest/verifier";
import { buildPayload } from "./apns/payload";
import { getApp, type AppConfig } from "./apps";
import {
  AuthenticationError,
  capabilityDigest,
  capabilityValueDigest,
  channelReference,
  deriveChannelName,
  readAdminCapability,
  readCapability,
  readInstallationCapability,
  toHex,
} from "./auth";
import {
  ChannelObject,
  type DeliveryResult,
} from "./channel/ChannelObject";
import {
  writeApnsReasonMetrics,
  writeMetric,
} from "./observability/analytics";
import {
  parseSampleRate,
  writeCompletionLog,
  type LogDetails,
} from "./observability/logger";
import type {
  DeliveryQueueMessage,
  Env,
  RequestContext,
} from "./types";
import {
  emptyBodyOnly,
  HttpError,
  readJsonObject,
  requireBase64,
  requireDeviceToken,
  requireEventCreatedAt,
  requireIdempotencyKey,
  requireInstallationID,
} from "./validation";

export { ChannelObject, ProvisioningObject };

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
    emitTelemetry(env, context, completed.details);
    return withSecurityHeaders(completed.response, context.requestID);
  },

  async queue(
    batch: MessageBatch<DeliveryQueueMessage>,
    env: Env,
  ): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      const app = getApp(body.appID);
      if (
        !app ||
        !/^[0-9a-f]{64}$/.test(body.channelID) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          body.eventID,
        ) ||
        !Number.isInteger(body.batchID) ||
        body.batchID < 0
      ) {
        console.warn({
          schema: 1,
          level: "warn",
          operation: "queue_delivery",
          outcome: "invalid_queue_message",
        });
        message.ack();
        continue;
      }
      try {
        const stub = env.CHANNELS.get(env.CHANNELS.idFromString(body.channelID));
        const result = await stub.deliverBatch(
          body.eventID,
          body.batchID,
          app,
        );
        if (result.retryable) {
          if (message.attempts >= 10) {
            console.warn({
              schema: 1,
              level: "warn",
              operation: "queue_delivery",
              outcome: "delivery_near_dlq",
            });
          }
          message.retry({ delaySeconds: retryDelay(message.attempts) });
        } else {
          message.ack();
        }
      } catch {
        if (message.attempts >= 10) {
          console.warn({
            schema: 1,
            level: "warn",
            operation: "queue_delivery",
            outcome: "exception_near_dlq",
          });
        }
        message.retry({ delaySeconds: retryDelay(message.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env, DeliveryQueueMessage>;

async function route(
  request: Request,
  env: Env,
  context: RequestContext,
): Promise<Completed> {
  const url = new URL(request.url);
  if (url.search !== "") {
    throw new HttpError(404, "not_found", "Not found");
  }
  if (request.method === "GET" && url.pathname === "/health") {
    context.operation = "health";
    if (
      env.APNS_KEY_ENVIRONMENT !== env.APNS_ENVIRONMENT ||
      env.APP_ATTEST_ENVIRONMENT !== env.APNS_ENVIRONMENT
    ) {
      return error(
        503,
        "misconfigured",
        "Service unavailable",
        "environment_mismatch",
      );
    }
    return ok(
      {
        status: "ok",
        environment: env.APNS_ENVIRONMENT,
        version: env.SERVICE_VERSION,
      },
      { outcome: "healthy", httpStatus: 200 },
    );
  }

  const match = url.pathname.match(
    /^\/v1\/apps\/([a-z0-9_]+)\/(app-attest\/challenge|app-attest\/keys|channel|device|events)$/,
  );
  if (!match) throw new HttpError(404, "not_found", "Not found");
  const appID = match[1] ?? "";
  const resource = match[2] ?? "";
  const app = getApp(appID);
  if (!app) throw new HttpError(404, "not_found", "Not found");
  context.appID = appID;

  if (resource === "app-attest/challenge" && request.method === "POST") {
    context.operation = "app_attest_challenge";
    const body = await readJsonObject(request, ["purpose", "keyID"]);
    const purpose = body.purpose;
    if (
      purpose !== "attest_key" &&
      purpose !== "provision_channel"
    ) {
      throw new HttpError(400, "invalid_request", "Invalid request");
    }
    const keyID = readKeyID(body.keyID);
    let bindingDigest: string | undefined;
    if (purpose === "provision_channel") {
      const channel = await resolveChannel(request, env, context, appID);
      const adminCapability = readAdminCapability(request);
      bindingDigest = await provisioningBindingDigest(
        appID,
        env.APNS_ENVIRONMENT,
        channel.capability,
        adminCapability,
      );
    }
    const stub = await provisioningStub(env, app, appID, keyID);
    const result = await stub.issueChallenge({
      appID,
      ...(bindingDigest ? { bindingDigest } : {}),
      keyID,
      purpose:
        purpose === "attest_key" ? "key-attestation" : "channel-provision",
    });
    if (!result.ok) return provisioningFailure(result);
    return ok(
      {
        challengeID: result.challengeID,
        challenge: result.challenge,
        expiresIn: result.expiresIn,
      },
      { outcome: "challenge_issued", httpStatus: 201 },
      201,
    );
  }

  if (resource === "app-attest/keys" && request.method === "POST") {
    context.operation = "app_attest_register";
    const body = await readJsonObject(request, [
      "keyID",
      "challengeID",
      "attestationObject",
    ]);
    const keyID = readKeyID(body.keyID);
    const challengeID = requireUUID(body.challengeID);
    const attestation = requireBase64(
      body.attestationObject,
      64 * 1_024,
    );
    const result = await (
      await provisioningStub(
      env,
      app,
      appID,
      keyID,
      )
    ).registerKey({
      app,
      appID,
      attestation,
      challengeID,
      keyID,
    });
    if (!result.ok) return provisioningFailure(result);
    return ok(
      { registered: true },
      {
        outcome: result.registered
          ? "attestation_registered"
          : "attestation_already_registered",
        httpStatus: result.registered ? 201 : 200,
      },
      result.registered ? 201 : 200,
    );
  }

  const channel = await resolveChannel(request, env, context, appID);

  if (resource === "channel" && request.method === "PUT") {
    context.operation = "provision_channel";
    const adminCapability = readAdminCapability(request);
    const adminDigest = await capabilityDigest(
      "admin",
      appID,
      adminCapability,
    );
    const body = await readJsonObject(request, [
      "keyID",
      "challengeID",
      "assertion",
    ]);
    const keyID = readKeyID(body.keyID);
    const bindingDigest = await provisioningBindingDigest(
      appID,
      env.APNS_ENVIRONMENT,
      channel.capability,
      adminCapability,
    );
    const verification = await (
      await provisioningStub(
      env,
      app,
      appID,
      keyID,
      )
    ).verifyProvision({
      app,
      appID,
      assertion: requireBase64(body.assertion, 16 * 1_024),
      bindingDigest,
      challengeID: requireUUID(body.challengeID),
      keyID,
    });
    if (!verification.ok) return provisioningFailure(verification);
    const result = await channel.stub.provision(adminDigest);
    if (!result.ok) return mutationFailure(result);
    return ok(
      { provisioned: true },
      {
        outcome: result.alreadyProvisioned
          ? "already_provisioned"
          : "provisioned",
        httpStatus: result.alreadyProvisioned ? 200 : 201,
      },
      result.alreadyProvisioned ? 200 : 201,
    );
  }

  if (resource === "device" && request.method === "PUT") {
    context.operation = "register";
    const installationDigest = await capabilityDigest(
      "installation",
      appID,
      readInstallationCapability(request),
    );
    const body = await readJsonObject(request, [
      "installationID",
      "deviceToken",
    ]);
    const result = await channel.stub.registerDevice(
      requireInstallationID(String(body.installationID ?? "")),
      requireDeviceToken(body.deviceToken),
      installationDigest,
    );
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

  if (resource === "device" && request.method === "DELETE") {
    context.operation = "unregister";
    const installationDigest = await capabilityDigest(
      "installation",
      appID,
      readInstallationCapability(request),
    );
    const body = await readJsonObject(request, ["installationID"]);
    const result = await channel.stub.unregisterDevice(
      requireInstallationID(String(body.installationID ?? "")),
      installationDigest,
    );
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

  if (resource === "events" && request.method === "POST") {
    context.operation = "publish";
    const idempotencyKey = requireIdempotencyKey(request);
    const clientCreatedAt = requireEventCreatedAt(request);
    const body = await readJsonObject(request, [
      "event",
      "excludeInstallationID",
    ]);
    if (typeof body.event !== "string") {
      throw new HttpError(400, "invalid_request", "Invalid request");
    }
    const excludeInstallationID =
      body.excludeInstallationID === undefined
        ? undefined
        : requireInstallationID(String(body.excludeInstallationID));
    const excludeInstallationCapabilityDigest = excludeInstallationID
      ? await capabilityDigest(
          "installation",
          appID,
          readInstallationCapability(request),
        )
      : undefined;
    buildPayload(app, body.event);
    const fingerprint = await requestFingerprint(
      body.event,
      clientCreatedAt,
      excludeInstallationID,
    );
    const result = await channel.stub.publish({
      app,
      appID,
      clientCreatedAt,
      event: body.event,
      ...(excludeInstallationID ? { excludeInstallationID } : {}),
      ...(excludeInstallationCapabilityDigest
        ? { excludeInstallationCapabilityDigest }
        : {}),
      fingerprint,
      idempotencyKey,
    });
    if (!result.ok) return mutationFailure(result);

    let deliveryDetails: DeliveryResult | undefined;
    if (result.mode === "direct" && result.pendingBatchIDs.length === 1) {
      deliveryDetails = await channel.stub.deliverBatch(
        result.eventID,
        result.pendingBatchIDs[0] ?? 0,
        app,
      );
      if (deliveryDetails.retryable) {
        await enqueueBatches(
          env,
          appID,
          channel.stub.id.toString(),
          result.eventID,
          result.pendingBatchIDs,
        );
        await channel.stub.markEnqueued(
          result.eventID,
          result.pendingBatchIDs,
        );
      }
    } else if (result.pendingBatchIDs.length > 0) {
      await enqueueBatches(
        env,
        appID,
        channel.stub.id.toString(),
        result.eventID,
        result.pendingBatchIDs,
      );
      await channel.stub.markEnqueued(result.eventID, result.pendingBatchIDs);
    }

    const responseState =
      deliveryDetails && !deliveryDetails.retryable
        ? "completed"
        : result.state;
    const responseStatus =
      result.mode === "queued" || deliveryDetails?.retryable ? 202 : 200;
    return ok(
      {
        eventID: result.eventID,
        deliveryMode:
          deliveryDetails?.retryable ? "queued" : result.mode,
        state: responseState,
      },
      {
        outcome: "accepted",
        httpStatus: responseStatus,
        event: body.event,
        idempotency: result.idempotency,
        ...(deliveryDetails
          ? {
              acceptedCount: deliveryDetails.accepted,
              failedCount: deliveryDetails.failed,
              invalidTokenRemovalCount: deliveryDetails.invalidRemoved,
              apnsReason: deliveryDetails.apnsReason,
              apnsReasonCounts: deliveryDetails.apnsReasonCounts,
              apnsStatus: deliveryDetails.apnsStatus,
              ...(deliveryDetails.apnsRequestID
                ? { apnsRequestID: deliveryDetails.apnsRequestID }
                : {}),
              apnsLatencyTotalMs: deliveryDetails.apnsLatencyTotalMs,
              apnsLatencyMaxMs: deliveryDetails.apnsLatencyMaxMs,
            }
          : {}),
      },
      responseStatus,
    );
  }

  if (resource === "channel" && request.method === "DELETE") {
    context.operation = "close_channel";
    emptyBodyOnly(request);
    const adminDigest = await capabilityDigest(
      "admin",
      appID,
      readAdminCapability(request),
    );
    const result = await channel.stub.closeChannel(adminDigest);
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

async function resolveChannel(
  request: Request,
  env: Env,
  context: RequestContext,
  appID: string,
): Promise<{
  capability: string;
  name: string;
  stub: DurableObjectStub<ChannelObject>;
}> {
  const capability = readCapability(request);
  const name = await deriveChannelName(appID, capability);
  context.channelRef = await channelReference(env.LOG_CORRELATION_KEY, name);
  return {
    capability,
    name,
    stub: env.CHANNELS.get(env.CHANNELS.idFromName(name)),
  };
}

async function provisioningStub(
  env: Env,
  app: AppConfig,
  appID: string,
  keyID: string,
): Promise<DurableObjectStub<ProvisioningObject>> {
  const shard = await provisioningShard(
    appID,
    keyID,
    app.provisioning.shardCount,
  );
  const name = `${appID}:v${app.provisioning.shardVersion}:${shard
    .toString(16)
    .padStart(2, "0")}`;
  return env.PROVISIONING.get(env.PROVISIONING.idFromName(name));
}

export async function provisioningShard(
  appID: string,
  keyID: string,
  shardCount: number,
): Promise<number> {
  if (
    !/^[a-z0-9_]{1,64}$/.test(appID) ||
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    shardCount > 65_536
  ) {
    throw new AppAttestVerificationError();
  }
  const keyBytes = decodeAppleKeyIDForShard(keyID);
  const appBytes = new TextEncoder().encode(`${appID}\0`);
  const input = new Uint8Array(appBytes.byteLength + keyBytes.byteLength);
  input.set(appBytes);
  input.set(keyBytes, appBytes.byteLength);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", input),
  );
  let shard = 0;
  for (const byte of digest) {
    shard = (shard * 256 + byte) % shardCount;
  }
  return shard;
}

async function enqueueBatches(
  env: Env,
  appID: string,
  channelID: string,
  eventID: string,
  batchIDs: number[],
): Promise<void> {
  for (let offset = 0; offset < batchIDs.length; offset += 100) {
    await env.DELIVERY_QUEUE.sendBatch(
      batchIDs.slice(offset, offset + 100).map((batchID) => ({
        body: { appID, channelID, eventID, batchID },
      })),
    );
  }
}

function mutationFailure(result: {
  ok: false;
  code:
    | "not_found"
    | "rate_limited"
    | "idempotency_conflict"
    | "credential_conflict";
  retryAfter?: number;
}): Completed {
  if (result.code === "rate_limited") {
    return error(
      429,
      "rate_limited",
      "Too many requests",
      "rate_limited",
      { "retry-after": String(result.retryAfter ?? 1) },
    );
  }
  if (result.code === "idempotency_conflict") {
    return error(
      409,
      "idempotency_conflict",
      "Idempotency key was already used",
      "idempotency_conflict",
    );
  }
  if (result.code === "credential_conflict") {
    return error(409, "conflict", "Request conflicts with existing state", "conflict");
  }
  return error(404, "not_found", "Not found", "authentication_rejected");
}

function provisioningFailure(result: {
  ok: false;
  code: "invalid_attestation" | "rate_limited";
  retryAfter?: number;
}): Completed {
  return result.code === "rate_limited"
    ? error(
        429,
        "rate_limited",
        "Too many requests",
        "rate_limited",
        { "retry-after": String(result.retryAfter ?? 1) },
      )
    : error(404, "not_found", "Not found", "attestation_rejected");
}

function handleError(value: unknown): Completed {
  if (
    value instanceof AuthenticationError ||
    value instanceof AppAttestVerificationError
  ) {
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
  return { response: json(body, status, headers), details };
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
  wrapped.headers.set("strict-transport-security", "max-age=31536000");
  wrapped.headers.set("x-content-type-options", "nosniff");
  wrapped.headers.set("x-frame-options", "DENY");
  wrapped.headers.set("x-request-id", requestID);
  return wrapped;
}

async function provisioningBindingDigest(
  appID: string,
  environment: string,
  channelCapability: string,
  adminCapability: string,
): Promise<string> {
  const channelDigest = await capabilityValueDigest(channelCapability);
  const adminDigest = await capabilityValueDigest(adminCapability);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [
        "apnw-provision-binding-v1",
        "PUT",
        "provision_channel",
        environment,
        appID,
        channelDigest,
        adminDigest,
      ].join("\n"),
    ),
  );
  return toHex(new Uint8Array(digest));
}

async function requestFingerprint(
  event: string,
  clientCreatedAt: number,
  excludeInstallationID?: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([event, clientCreatedAt, excludeInstallationID ?? null]),
    ),
  );
  return toHex(new Uint8Array(digest));
}

function readKeyID(value: unknown): string {
  try {
    return normalizeAppAttestKeyID(value);
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
}

function decodeAppleKeyIDForShard(value: string): Uint8Array {
  try {
    const normalized = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(normalized), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32) throw new Error("key");
    return bytes;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
}

function requireUUID(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw new HttpError(400, "invalid_request", "Invalid request");
  }
  return value;
}

function retryDelay(attempts: number): number {
  return Math.min(300, 2 ** Math.min(attempts, 8));
}

function emitTelemetry(
  env: Env,
  context: RequestContext,
  details: LogDetails,
): void {
  writeCompletionLog(
    context,
    details,
    parseSampleRate(env.LOG_SAMPLE_RATE),
  );
  writeMetric(env, context, {
    outcome: details.outcome,
    httpStatus: details.httpStatus,
    ...(details.event ? { event: details.event } : {}),
    ...(details.apnsReason ? { apnsReason: details.apnsReason } : {}),
    ...(details.idempotency ? { idempotency: details.idempotency } : {}),
    targetCount: details.targetCount,
    acceptedCount: details.acceptedCount,
    failedCount: details.failedCount,
    invalidTokenRemovalCount: details.invalidTokenRemovalCount,
    apnsLatencyTotalMs: details.apnsLatencyTotalMs,
    apnsLatencyMaxMs: details.apnsLatencyMaxMs,
    registrationDelta: details.operationDelta,
    tokenReplacementCount: details.tokenReplacementCount,
  });
  writeApnsReasonMetrics(env, context, details.apnsReasonCounts);
}
