SELECT
  blob5 AS service_version,
  index1 AS app_id,
  SUM(_sample_interval * double1) AS requests,
  SUM(
    IF(double11 >= 500, _sample_interval * double1, 0)
  ) AS server_errors,
  IF(requests = 0, 0, server_errors / requests) AS server_error_rate,
  quantile(0.95)(double2) AS api_p95_ms
FROM apnw_prod
WHERE timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY service_version, app_id
ORDER BY service_version DESC, app_id;
