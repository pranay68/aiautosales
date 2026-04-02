import { loadEnv } from "@aiautosales/config";

type SonetelCallRequest = {
  to: string;
  prospectId: string;
};

type SonetelTokenPayload = {
  access_token?: string;
  [key: string]: unknown;
};

type SonetelExecutionResult = {
  live: boolean;
  endpoint: string;
  providerCallId?: string;
  providerStatus?: string;
  payload: Record<string, unknown>;
  rawResponse?: unknown;
};

type SonetelAuthContext = {
  provider: "sonetel";
  accessToken: string;
  accountId: string;
  outgoingCallerId: string;
  agentDestination: string;
  callbackEndpoint: string;
  liveOutboundEnabled: boolean;
};

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getCallbackEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/make-calls/call/call-back`;
}

function getDisplayNumber(outgoingCallerId: string): string {
  return outgoingCallerId || "automatic";
}

function isValidAgentDestinationFormat(destination: string): boolean {
  if (!destination) {
    return false;
  }

  if (/^https?:\/\//i.test(destination)) {
    return false;
  }

  return (
    /^sip:[^\s]+$/i.test(destination) ||
    /^tel:\+?[0-9][0-9()-\s.]{4,}$/.test(destination) ||
    /^\+?[0-9][0-9()-\s.]{6,}$/.test(destination)
  );
}

function ensureLiveOutboundReady(context: SonetelAuthContext): void {
  const missing: string[] = [];

  if (!context.agentDestination) {
    missing.push("SONETEL_AGENT_DESTINATION");
  }

  if (!context.outgoingCallerId) {
    missing.push("SONETEL_OUTGOING_CALLER_ID");
  }

  if (!isValidAgentDestinationFormat(context.agentDestination)) {
    missing.push("SONETEL_AGENT_DESTINATION");
  }

  if (missing.length > 0) {
    throw new Error(
      `Sonetel live outbound is enabled but missing required config: ${missing.join(", ")}`
    );
  }
}

export async function getSonetelAccessToken(): Promise<string> {
  const env = loadEnv();

  if (env.sonetelAccessToken) {
    return env.sonetelAccessToken;
  }

  const basic = Buffer.from("sonetel-api:sonetel-api").toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    refresh: "yes",
    username: env.sonetelEmail,
    password: env.sonetelPassword
  });

  const response = await fetch("https://api.sonetel.com/SonetelAuth/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json, text/plain",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = (await response.json()) as SonetelTokenPayload;
  if (!response.ok || !payload.access_token) {
    throw new Error("Failed to get Sonetel access token.");
  }

  return payload.access_token;
}

export function deriveSonetelAccountId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    acc_id?: number | string;
  };

  if (!decoded.acc_id) {
    throw new Error("Could not derive Sonetel account id from access token.");
  }

  return String(decoded.acc_id);
}

export async function buildSonetelAuthContext(): Promise<SonetelAuthContext> {
  const env = loadEnv();
  const accessToken = await getSonetelAccessToken();
  const accountId = env.sonetelAccountId || deriveSonetelAccountId(accessToken);

  return {
    provider: "sonetel" as const,
    accessToken,
    accountId,
    outgoingCallerId: env.sonetelOutgoingCallerId,
    agentDestination: env.sonetelAgentDestination,
    callbackEndpoint: getCallbackEndpoint(env.sonetelApiBaseUrl),
    liveOutboundEnabled: env.sonetelEnableLiveOutbound
  };
}

export async function createSonetelCallRequest(input: SonetelCallRequest) {
  const auth = await buildSonetelAuthContext();

  return {
    provider: auth.provider,
    accountId: auth.accountId,
    endpoint: auth.callbackEndpoint,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json"
    },
    payload: {
      app_id: `aiautosales:${input.prospectId}`,
      call1: auth.agentDestination || "missing-agent-destination",
      call2: input.to,
      show_1: "automatic",
      show_2: getDisplayNumber(auth.outgoingCallerId)
    }
  };
}

export async function executeSonetelOutboundCall(input: SonetelCallRequest): Promise<SonetelExecutionResult> {
  const request = await createSonetelCallRequest(input);
  const auth = await buildSonetelAuthContext();

  if (!auth.liveOutboundEnabled) {
    return {
      live: false,
      endpoint: request.endpoint,
      providerStatus: "dry_run",
      payload: request.payload
    };
  }

  ensureLiveOutboundReady(auth);

  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.payload)
  });

  const rawResponse = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `Sonetel outbound call failed with status ${response.status}: ${JSON.stringify(rawResponse)}`
    );
  }

  const responseRecord = rawResponse && typeof rawResponse === "object" ? (rawResponse as Record<string, unknown>) : {};

  return {
    live: true,
    endpoint: request.endpoint,
    providerCallId: String(
      responseRecord.callId ?? responseRecord.id ?? responseRecord.call_id ?? ""
    ) || undefined,
    providerStatus: String(
      responseRecord.status ?? responseRecord.callStatus ?? "submitted"
    ),
    payload: request.payload,
    rawResponse
  };
}

export function normalizeSonetelWebhookEvent(input: unknown) {
  const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const providerCallId = String(payload.callId ?? payload.id ?? payload.call_id ?? "");
  const providerStatus = String(payload.status ?? payload.callStatus ?? payload.event ?? "");

  return {
    provider: "sonetel" as const,
    providerCallId: providerCallId || undefined,
    providerStatus: providerStatus || "unknown",
    payload
  };
}

export async function validateSonetelConfiguration() {
  const auth = await buildSonetelAuthContext();
  const missingLiveOutboundConfig: string[] = [];
  const agentDestinationValid = isValidAgentDestinationFormat(auth.agentDestination);

  if (!auth.agentDestination) {
    missingLiveOutboundConfig.push("SONETEL_AGENT_DESTINATION");
  } else if (!agentDestinationValid) {
    missingLiveOutboundConfig.push("SONETEL_AGENT_DESTINATION_FORMAT");
  }

  if (!auth.outgoingCallerId) {
    missingLiveOutboundConfig.push("SONETEL_OUTGOING_CALLER_ID");
  }

  return {
    provider: auth.provider,
    accountId: auth.accountId,
    outgoingCallerIdPresent: Boolean(auth.outgoingCallerId),
    agentDestinationPresent: Boolean(auth.agentDestination),
    agentDestinationValid,
    liveOutboundEnabled: auth.liveOutboundEnabled,
    liveOutboundReady: missingLiveOutboundConfig.length === 0,
    missingLiveOutboundConfig,
    callbackEndpoint: auth.callbackEndpoint
  };
}
