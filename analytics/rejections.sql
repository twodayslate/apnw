SELECT
  toStartOfHour(timestamp) AS hour,
  index1 AS app_id,
  blob2 AS operation,
  blob3 AS outcome,
  SUM(_sample_interval * double1) AS requests
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND blob3 IN (
    'authentication_rejected',
    'validation_rejected',
    'rate_limited',
    'internal_error'
  )
GROUP BY hour, app_id, operation, outcome
ORDER BY hour DESC, requests DESC;
