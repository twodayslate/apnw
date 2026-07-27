SELECT
  toStartOfDay(timestamp) AS day,
  index1 AS app_id,
  SUM(_sample_interval * double3) AS targeted,
  SUM(_sample_interval * double4) AS accepted,
  SUM(_sample_interval * double5) AS failed,
  IF(targeted = 0, 0, accepted / targeted) AS acceptance_rate
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '30' DAY
  AND blob2 IN ('publish', 'queue_delivery')
GROUP BY day, app_id
ORDER BY day DESC, app_id;
