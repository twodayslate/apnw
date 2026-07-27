SELECT
  toStartOfDay(timestamp) AS day,
  index1 AS app_id,
  blob9 AS idempotency,
  SUM(_sample_interval * double1) AS publish_requests
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob2 = 'publish'
  AND blob9 != 'none'
GROUP BY day, app_id, idempotency
ORDER BY day DESC, app_id, idempotency;
