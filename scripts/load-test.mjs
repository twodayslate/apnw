import { readFile } from "node:fs/promises";

const baseURL = process.env.APNW_LOAD_URL;
const fixturePath = process.env.APNW_LOAD_FIXTURES;
const concurrency = Number(process.env.APNW_LOAD_CONCURRENCY ?? "10000");

if (!baseURL || !fixturePath) {
  throw new Error(
    "Set APNW_LOAD_URL and APNW_LOAD_FIXTURES to a nonproduction load environment",
  );
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20000) {
  throw new Error("APNW_LOAD_CONCURRENCY must be an integer from 1 through 20000");
}

const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
if (!Array.isArray(fixtures) || fixtures.length < 5000) {
  throw new Error("The acceptance workload requires at least 5000 provisioned channels");
}

const setupResults = [];
await runWithConcurrency(
  fixtures.map((fixture) => () => registerFixture(fixture, setupResults)),
  Math.min(concurrency, fixtures.length),
);
const setupFailures = setupResults.filter((result) => result.status >= 400);
if (setupFailures.length > 0) {
  console.log(
    JSON.stringify(
      {
        phase: "setup",
        channels: fixtures.length,
        failures: setupFailures.length,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  await runAcceptance();
}

async function runAcceptance() {
const results = [];
const tasks = fixtures.flatMap((fixture) => [
  () => publishFixture(fixture, results),
  () => publishFixture(fixture, results),
]);
const startedAt = performance.now();
await runWithConcurrency(tasks, concurrency);

const elapsedMs = performance.now() - startedAt;
const failures = results.filter((result) => result.status >= 400);
const throttled = failures.filter((result) => result.status === 429);
const serverErrors = failures.filter((result) => result.status >= 500);
const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
const report = {
  channels: fixtures.length,
  operations: results.length,
  requestedConcurrency: concurrency,
  elapsedMs: Math.round(elapsedMs),
  operationsPerSecond: Math.round((results.length * 1000) / elapsedMs),
  p50Ms: percentile(durations, 0.5),
  p95Ms: percentile(durations, 0.95),
  p99Ms: percentile(durations, 0.99),
  failures: failures.length,
  throttled: throttled.length,
  serverErrors: serverErrors.length,
};
console.log(JSON.stringify(report, null, 2));

if (results.length < 10_000 || failures.length > 0) {
  process.exitCode = 1;
}
}

async function registerFixture(fixture, sink) {
  validateFixture(fixture);
  const commonHeaders = {
    authorization: `Bearer ${fixture.channelCapability}`,
    "x-installation-authorization": `Bearer ${fixture.installationCapability}`,
    "content-type": "application/json",
  };
  await measuredFetch(
    new URL(`/v1/apps/${fixture.appID}/device`, baseURL),
    {
      method: "PUT",
      headers: commonHeaders,
      body: JSON.stringify({
        installationID: fixture.installationID,
        deviceToken: fixture.deviceToken,
      }),
    },
    "register",
    sink,
  );
}

async function publishFixture(fixture, sink) {
  validateFixture(fixture);
  const createdAt = new Date().toISOString();
  await measuredFetch(
    new URL(`/v1/apps/${fixture.appID}/events`, baseURL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.channelCapability}`,
        "x-installation-authorization": `Bearer ${fixture.installationCapability}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "event-created-at": createdAt,
      },
      body: JSON.stringify({
        event: fixture.event,
        excludeInstallationID: fixture.installationID,
      }),
    },
    "publish",
    sink,
  );
}

async function runWithConcurrency(tasks, maximum) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(maximum, tasks.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const task = tasks[index];
        if (!task) return;
        await task();
      }
    }),
  );
}

async function measuredFetch(url, init, operation, sink) {
  const started = performance.now();
  let status = 599;
  try {
    const response = await fetch(url, init);
    status = response.status;
    await response.arrayBuffer();
  } catch {
    // Do not print the URL, headers, or fixture.
  }
  sink.push({
    operation,
    status,
    durationMs: performance.now() - started,
  });
}

function validateFixture(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !/^[a-z0-9_]+$/.test(value.appID ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.channelCapability ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.installationCapability ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.installationID ?? "") ||
    !/^(?:[0-9a-f]{2}){1,256}$/.test(value.deviceToken ?? "") ||
    !/^[a-z0-9_]+$/.test(value.event ?? "")
  ) {
    throw new Error("Invalid load fixture");
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
}
