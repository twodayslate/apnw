export interface NotificationFallback {
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
  };
  readonly provisioning: {
    readonly shardCount: number;
    readonly shardVersion: number;
  };
  readonly notificationFallback: NotificationFallback;
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
    },
    provisioning: {
      shardCount: 256,
      shardVersion: 1,
    },
    notificationFallback: {
      title: "Chain of Custody",
      body: "You have a new update.",
    },
  },
} as const satisfies Readonly<Record<string, AppConfig>>;

export type AppID = keyof typeof apps;

export function getApp(appID: string): AppConfig | undefined {
  return (apps as Readonly<Record<string, AppConfig>>)[appID];
}
