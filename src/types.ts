import type { ChannelObject } from "./channel/ChannelObject";

export type ApnsEnvironment = "development" | "production";

export interface Env {
  APNS_ENVIRONMENT: ApnsEnvironment;
  SERVICE_VERSION: string;
  LOG_SAMPLE_RATE?: string;
  APNS_KEY_P8: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  CHANNEL_HMAC_KEY: string;
  CHANNELS: DurableObjectNamespace<ChannelObject>;
  APNW_ANALYTICS?: AnalyticsEngineDataset;
}

export interface RequestContext {
  appID?: string;
  channelRef?: string;
  colo?: string;
  deployment: ApnsEnvironment;
  operation: Operation;
  requestID: string;
  serviceVersion: string;
  startedAt: number;
}

export type Operation =
  | "health"
  | "register"
  | "unregister"
  | "publish"
  | "close_channel"
  | "not_found";
