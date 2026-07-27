export interface NotificationTemplate {
  readonly title: string;
  readonly body: string;
}

export interface AppConfig {
  readonly bundleID: string;
  readonly routeSchemes: readonly string[];
  readonly templates: Readonly<Record<string, NotificationTemplate>>;
}

export const apps = {
  chain_of_custody: {
    bundleID: "com.twodayslate.coc",
    routeSchemes: ["coc"],
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
