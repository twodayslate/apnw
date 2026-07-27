# APNW Analytics Engine queries

These queries target the production dataset, `apnw_prod`. Replace it with
`apnw_dev` when investigating the development deployment.

Field assignments are versioned in `src/observability/analytics.ts`:

| Field | Meaning |
| --- | --- |
| `index1` | Checked-in app ID, or `_service` |
| `blob1` | Deployment |
| `blob2` | Operation, or `apns_result` for per-category error points |
| `blob3` | Outcome |
| `blob4` | HTTP status class |
| `blob5` | Service version |
| `blob6` | Cloudflare colo |
| `blob7` | Checked-in event template, or `none` |
| `blob8` | Allowlisted APNs reason, or `none` |
| `blob9` | Idempotency outcome, or `none` |
| `double1` | Request count (`1`) |
| `double2` | API duration in milliseconds |
| `double3` | Target count |
| `double4` | APNs accepted count |
| `double5` | Failed count |
| `double6` | Invalid-token removal count |
| `double7` | Total APNs latency in milliseconds |
| `double8` | Maximum APNs latency in milliseconds |
| `double9` | Registration/channel-state delta |
| `double10` | Token replacement count |
| `double11` | HTTP status |

Analytics Engine may sample data. Counts therefore multiply values by
`_sample_interval`. Percentiles operate on the retained samples.

Queued delivery health is monitored with Cloudflare Queue built-in depth, age,
retry, and DLQ metrics. The publish request point records the durably accepted
target snapshot, while later `queue_delivery` points record asynchronous APNs
outcomes. `delivery-rate.sql` combines the two without pretending queued results
completed inside the HTTP request. Delivery counts remain operator-only and are
never returned by the public API.
