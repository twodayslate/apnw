SELECT
  toStartOfDay(timestamp) AS day,
  index1 AS app_id,
  blob2 AS operation,
  blob3 AS outcome,
  SUM(_sample_interval * double9) AS registration_delta,
  SUM(_sample_interval * double10) AS token_replacements,
  SUM(_sample_interval * double1) AS requests
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob2 IN ('register', 'unregister', 'close_channel')
GROUP BY day, app_id, operation, outcome
ORDER BY day DESC, app_id, operation;
