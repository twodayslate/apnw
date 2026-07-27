SELECT
  toStartOfHour(timestamp) AS hour,
  index1 AS app_id,
  blob2 AS operation,
  quantile(0.50)(double2) AS api_p50_ms,
  quantile(0.95)(double2) AS api_p95_ms,
  quantile(0.95)(double8) AS apns_max_p95_ms
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY hour, app_id, operation
ORDER BY hour DESC, app_id, operation;
