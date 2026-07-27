export interface NotificationTemplate {
  readonly title: string;
  readonly body: string;
}

export interface AppConfig {
  readonly bundleID: string;
  readonly appAttest: {
    readonly extensionPolicy: "if-present" | "required";
    readonly maxFraudRiskMetric: number;
    readonly allowedValidationCategories: {
      readonly development: readonly number[];
      readonly production: readonly number[];
    };
    readonly allowedBundleVersions: readonly string[];
  };
  readonly provisioning: {
    readonly shardCount: number;
    readonly shardVersion: number;
  };
  readonly templates: Readonly<Record<string, NotificationTemplate>>;
}

export const apps = {
  chain_of_custody: {
    bundleID: "com.twodayslate.coc",
    appAttest: {
      extensionPolicy: "if-present",
      // Tune from production observations. Reinstalls and device transfers can
      // legitimately increase Apple's rolling 30-day count.
      maxFraudRiskMetric: 10,
      allowedValidationCategories: {
        development: [3],
        production: [2, 4],
      },
      // Keep this list synchronized with CFBundleVersion values that are
      // currently allowed to provision new channels.
      allowedBundleVersions: ["1"],
    },
    provisioning: {
      shardCount: 256,
      shardVersion: 1,
    },
    templates: {
      check_requested: {
        title: "CoC update",
        body: "A new response is requested.",
      },
      assignment_available: {
        title: "CoC update",
        body: "A new assignment is available.",
      },
      submission_ready: {
        title: "CoC update",
        body: "A response is ready for review.",
      },
      decision_available: {
        title: "CoC update",
        body: "A response decision is available.",
      },
      release_requested: {
        title: "CoC update",
        body: "A release request is ready for review.",
      },
      pause_requested: {
        title: "CoC update",
        body: "A pause request is ready for review.",
      },
    },
  },
} as const satisfies Readonly<Record<string, AppConfig>>;

export type AppID = keyof typeof apps;

export function getApp(appID: string): AppConfig | undefined {
  return (apps as Readonly<Record<string, AppConfig>>)[appID];
}
