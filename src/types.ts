import type { ChannelObject } from "./channel/ChannelObject";
import type { ProvisioningObject } from "./appattest/ProvisioningObject";

export type ApnsEnvironment = "development" | "production";
export type AppAttestEnvironment = "development" | "production";

export interface DeliveryQueueMessage {
  appID: string;
  channelID: string;
  eventID: string;
  batchID: number;
}

export interface Env {
  APNS_ENVIRONMENT: ApnsEnvironment;
  APNS_KEY_ENVIRONMENT: ApnsEnvironment;
  APP_ATTEST_ENVIRONMENT: AppAttestEnvironment;
  SERVICE_VERSION: string;
  LOG_SAMPLE_RATE?: string;
  APNS_CIRCUIT_MIN_ATTEMPTS?: string;
  APNS_CIRCUIT_FAILURE_RATE?: string;
  APNS_CIRCUIT_WINDOW_SECONDS?: string;
  APNS_CIRCUIT_OPEN_SECONDS?: string;
  APNS_KEY_P8: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  DEVICECHECK_KEY_P8: string;
  DEVICECHECK_KEY_ID: string;
  APP_ATTEST_ROOT_CERT_PEM: string;
  LOG_CORRELATION_KEY: string;
  CHANNELS: DurableObjectNamespace<ChannelObject>;
  PROVISIONING: DurableObjectNamespace<ProvisioningObject>;
  DELIVERY_QUEUE: Queue<DeliveryQueueMessage>;
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
  | "app_attest_challenge"
  | "app_attest_register"
  | "provision_channel"
  | "register"
  | "unregister"
  | "publish"
  | "queue_delivery"
  | "close_channel"
  | "not_found";
