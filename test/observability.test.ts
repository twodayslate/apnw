import { describe, expect, it, vi } from "vitest";
import {
  writeApnsReasonMetrics,
  writeMetric,
} from "../src/observability/analytics";
import {
  writeCompletionLog,
} from "../src/observability/logger";
import type { Env, RequestContext } from "../src/types";

describe("aggregate analytics", () => {
  it("uses only bounded service dimensions and aggregate measures", () => {
    const writeDataPoint = vi.fn();
    const context: RequestContext = {
      appID: "chain_of_custody",
      channelRef: "must-not-appear",
      colo: "IAD",
      deployment: "development",
      operation: "publish",
      requestID: "must-not-appear",
      serviceVersion: "test",
      startedAt: Date.now(),
    };
    writeMetric(
      { APNW_ANALYTICS: { writeDataPoint } } as unknown as Env,
      context,
      {
        outcome: "accepted",
        httpStatus: 200,
        event: "submission_ready",
        targetCount: 2,
        acceptedCount: 2,
      },
    );
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]?.[0];
    const serialized = JSON.stringify(point);
    expect(point.indexes).toEqual(["chain_of_custody"]);
    expect(serialized).not.toContain(context.requestID);
    expect(serialized).not.toContain(context.channelRef);
  });

  it("does not let an analytics failure affect the caller", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = {
      APNW_ANALYTICS: {
        writeDataPoint() {
          throw new Error("analytics unavailable");
        },
      },
    } as unknown as Env;
    expect(() =>
      writeMetric(
        env,
        {
          deployment: "production",
          operation: "health",
          requestID: "request",
          serviceVersion: "test",
          startedAt: Date.now(),
        },
        { outcome: "healthy", httpStatus: 200 },
      ),
    ).not.toThrow();
    warn.mockRestore();
  });

  it("replaces unreviewed dimensions instead of logging their values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const secret = "secret-value-with spaces";
    writeCompletionLog(
      {
        appID: secret,
        channelRef: secret,
        deployment: "development",
        operation: "publish",
        requestID: crypto.randomUUID(),
        serviceVersion: secret,
        startedAt: Date.now(),
      },
      {
        outcome: secret,
        httpStatus: 200,
        event: secret,
        apnsReason: secret,
        apnsRequestID: secret,
      },
      1,
    );
    const serialized = JSON.stringify(log.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("invalid_dimension");
    expect(serialized).toContain("invalid-version");
    log.mockRestore();
  });

  it("sanitizes every dimension in per-reason APNs metrics", () => {
    const writeDataPoint = vi.fn();
    const secret = "attacker controlled value";
    writeApnsReasonMetrics(
      {
        APNW_ANALYTICS: { writeDataPoint },
      } as unknown as Env,
      {
        appID: "chain_of_custody",
        colo: secret,
        deployment: "development",
        operation: "queue_delivery",
        requestID: crypto.randomUUID(),
        serviceVersion: secret,
        startedAt: Date.now(),
      },
      { "not reviewed": 1 },
    );

    const serialized = JSON.stringify(writeDataPoint.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("invalid-version");
    expect(serialized).toContain("invalid_dimension");
    expect(serialized).toContain("unknown");
  });
});
