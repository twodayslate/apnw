import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          APNS_KEY_P8:
            "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lCQVFRZ1haK2FKeVV5L3dKb21TV0sKbUVrZEx3eFRTS2hXcHNSUnZFblFrcFU2NmoraFJBTkNBQVJiR2pFNEw2eStWVGRDYUpnSlJabTU0QWt6Y3NVRQpzUEczTytqWi85a1NLTUtFYURLZ0ZNRlNSOWoxVE1lZGRPTi9WTlFZTWtyNTNlWmJGRVFHeHhTRwotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==",
          APNS_KEY_ID: "TESTKEY123",
          APNS_TEAM_ID: "TESTTEAM12",
          DEVICECHECK_KEY_P8: "NOT_USED_IN_UNIT_TESTS",
          DEVICECHECK_KEY_ID: "TESTDC1234",
          APNS_KEY_ENVIRONMENT: "development",
          APP_ATTEST_ENVIRONMENT: "development",
          APP_ATTEST_ROOT_CERT_PEM:
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
          LOG_CORRELATION_KEY:
            "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
        },
      },
    }),
  ],
});
