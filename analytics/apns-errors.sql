SELECT
  toStartOfHour(timestamp) AS hour,
  index1 AS app_id,
  blob8 AS apns_reason,
  SUM(_sample_interval * double5) AS failures,
  SUM(_sample_interval * double6) AS invalid_tokens_removed
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND blob2 = 'apns_result'
  AND blob8 != 'none'
GROUP BY hour, app_id, apns_reason
ORDER BY hour DESC, failures DESC;
