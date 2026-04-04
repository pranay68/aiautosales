import { loadEnv } from "@aiautosales/config";
import { log } from "@aiautosales/telemetry";
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
  apiBaseUrl: string;
  accessToken: string;
  accountId: string;
  userId: string;
  outgoingCallerId: string;
  call1Destination: string;
  agentDestination: string;
  callbackEndpoint: string;
  liveOutboundEnabled: boolean;
};

const SONETEL_RETRYABLE_STATUS_CODES = new Set([404, 429, 500, 502, 503, 504]);
const SONETEL_MAX_ATTEMPTS = 3;
const SONETEL_FORWARDING_SETTLE_MS = 1200;

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getCallbackEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/make-calls/call/call-back`;
}

function getCallForwardingEndpoint(baseUrl: string, accountId: string, phoneNumber: string): string {
  const normalizedNumber = phoneNumber.replace(/^\+/, "");
  return `${normalizeBaseUrl(baseUrl)}/account/${accountId}/phonenumbersubscription/${normalizedNumber}`;
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
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination) ||
    /^sip:[^\s]+$/i.test(destination) ||
    /^tel:\+?[0-9][0-9()-\s.]{4,}$/.test(destination) ||
    /^\+?[0-9][0-9()-\s.]{6,}$/.test(destination)
  );
}

function isEmailDestination(destination: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination);
}

function ensureLiveOutboundReady(context: SonetelAuthContext): void {
  const missing: string[] = [];

  if (!context.call1Destination) {
    missing.push("SONETEL_CALL1_DESTINATION");
  }

  if (!context.outgoingCallerId) {
    missing.push("SONETEL_OUTGOING_CALLER_ID");
  }

  if (!isValidAgentDestinationFormat(context.call1Destination)) {
    missing.push("SONETEL_CALL1_DESTINATION_FORMAT");
  }

  if (missing.length > 0) {
    throw new Error(
      `Sonetel live outbound is enabled but missing required config: ${missing.join(", ")}`
    );
  }
}

type JsonResponse = {
  statusCode: number;
  bodyText: string;
  bodyJson: unknown;
};

async function requestJson(input: {
  method: "POST" | "PUT";
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<JsonResponse> {
  const response = await fetch(input.endpoint, {
    method: input.method,
    headers: input.headers,
    body: JSON.stringify(input.body)
  });

  const bodyText = await response.text();

  let bodyJson: unknown = undefined;
  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = bodyText;
    }
  }

  return {
    statusCode: response.status,
    bodyText,
    bodyJson
  };
}

export async function getSonetelAccessToken(forceRefresh = false): Promise<string> {
  const env = loadEnv();

  if (env.sonetelAccessToken && !forceRefresh) {
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

export function deriveSonetelUserId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    user_id?: number | string;
  };

  if (!decoded.user_id) {
    throw new Error("Could not derive Sonetel user id from access token.");
  }

  return String(decoded.user_id);
}

export async function buildSonetelAuthContext(forceRefresh = false): Promise<SonetelAuthContext> {
  const env = loadEnv();
  const accessToken = await getSonetelAccessToken(forceRefresh);
  const accountId = env.sonetelAccountId || deriveSonetelAccountId(accessToken);
  const userId = deriveSonetelUserId(accessToken);

  return {
    provider: "sonetel" as const,
    apiBaseUrl: env.sonetelApiBaseUrl,
    accessToken,
    accountId,
    userId,
    outgoingCallerId: env.sonetelOutgoingCallerId,
    call1Destination: env.sonetelCall1Destination,
    agentDestination: env.sonetelAgentDestination,
    callbackEndpoint: getCallbackEndpoint(env.sonetelApiBaseUrl),
    liveOutboundEnabled: env.sonetelEnableLiveOutbound
  };
}

export async function createSonetelCallRequest(input: SonetelCallRequest) {
  const auth = await buildSonetelAuthContext();
  const call1 = normalizeSonetelSipTarget(auth.call1Destination);

  return {
    provider: auth.provider,
    accountId: auth.accountId,
    endpoint: auth.callbackEndpoint,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "aiautosales/1.0"
    },
    payload: {
      app_id: `aiautosales:${input.prospectId}`,
      call1,
      call2: input.to,
      show_1: "automatic",
      show_2: getDisplayNumber(auth.outgoingCallerId)
    }
  };
}

export async function syncSonetelAgentForwarding(): Promise<{
  endpoint: string;
  payload: Record<string, unknown>;
  rawResponse: unknown;
}> {
  const auth = await buildSonetelAuthContext();
  return syncSonetelAgentForwardingWithContext(auth);
}

async function syncSonetelAgentForwardingWithContext(auth: SonetelAuthContext): Promise<{
  endpoint: string;
  payload: Record<string, unknown>;
  rawResponse: unknown;
}> {
  ensureLiveOutboundReady(auth);

  const endpoint = getCallForwardingEndpoint(auth.apiBaseUrl, auth.accountId, auth.outgoingCallerId);
  const payload = {
    connect_to_type: "user",
    connect_to: auth.userId
  };

  let lastResponse: JsonResponse | undefined;
  for (let attempt = 1; attempt <= SONETEL_MAX_ATTEMPTS; attempt += 1) {
    const response = await requestJson({
      method: "PUT",
      endpoint,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: payload
    });
    lastResponse = response;

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { endpoint, payload, rawResponse: response.bodyJson };
    }

    log("warn", "sonetel.forwarding.retryable_failure", {
      attempt,
      endpoint,
      statusCode: response.statusCode,
      body: response.bodyJson ?? response.bodyText
    });

    if (!SONETEL_RETRYABLE_STATUS_CODES.has(response.statusCode) || attempt === SONETEL_MAX_ATTEMPTS) {
      break;
    }

    await waitForSonetelBackoff(attempt);
  }

  throw new Error(
    `Sonetel call forwarding update failed with status ${lastResponse?.statusCode}: ${JSON.stringify(lastResponse?.bodyJson ?? lastResponse?.bodyText)}`
  );
}

function normalizeSonetelSipTarget(destination: string): string {
  if (!destination.startsWith("sip:")) {
    return destination;
  }

  if (destination.includes("sip.sonetel.com")) {
    return destination;
  }

  return destination.includes(":5060") ? destination : `${destination}:5060`;
}

export async function executeSonetelOutboundCall(input: SonetelCallRequest): Promise<SonetelExecutionResult> {
  let auth = await buildSonetelAuthContext();
  let request = await createSonetelCallRequest(input);

  if (!auth.liveOutboundEnabled) {
    return {
      live: false,
      endpoint: request.endpoint,
      providerStatus: "dry_run",
      payload: request.payload
    };
  }

  ensureLiveOutboundReady(auth);
  let forwarding: { endpoint: string; payload: Record<string, unknown>; rawResponse: unknown } | undefined;
  let response: JsonResponse | undefined;

  for (let attempt = 1; attempt <= SONETEL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      auth = await buildSonetelAuthContext(true);
      request = {
        provider: auth.provider,
        accountId: auth.accountId,
        endpoint: auth.callbackEndpoint,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "aiautosales/1.0"
        },
        payload: {
          ...request.payload,
          call1: normalizeSonetelSipTarget(auth.call1Destination)
        }
      };
    }

    forwarding = isEmailDestination(auth.agentDestination)
      ? undefined
      : await syncSonetelAgentForwardingWithContext(auth);

    if (forwarding) {
      await wait(SONETEL_FORWARDING_SETTLE_MS);
    }

    response = await requestJson({
      method: "POST",
      endpoint: request.endpoint,
      headers: request.headers,
      body: request.payload
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      break;
    }

    log("warn", "sonetel.callback.retryable_failure", {
      attempt,
      endpoint: request.endpoint,
      payload: request.payload,
      statusCode: response.statusCode,
      body: response.bodyJson ?? response.bodyText
    });

    if (!SONETEL_RETRYABLE_STATUS_CODES.has(response.statusCode) || attempt === SONETEL_MAX_ATTEMPTS) {
      break;
    }

    await waitForSonetelBackoff(attempt);
  }

  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Sonetel outbound call failed with status ${response?.statusCode}: ${JSON.stringify(response?.bodyJson ?? response?.bodyText)}`
    );
  }

  const responseRecord =
    response.bodyJson && typeof response.bodyJson === "object" ? (response.bodyJson as Record<string, unknown>) : {};

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
    rawResponse: {
      callback: response.bodyJson,
      forwarding
    }
  };
}

async function wait(durationMs: number) {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitForSonetelBackoff(attempt: number) {
  const base = 1000 * attempt;
  const jitter = Math.floor(Math.random() * 500);
  await wait(base + jitter);
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
  const call1DestinationValid = isValidAgentDestinationFormat(auth.call1Destination);

  if (!auth.call1Destination) {
    missingLiveOutboundConfig.push("SONETEL_CALL1_DESTINATION");
  } else if (!call1DestinationValid) {
    missingLiveOutboundConfig.push("SONETEL_CALL1_DESTINATION_FORMAT");
  }

  if (!auth.outgoingCallerId) {
    missingLiveOutboundConfig.push("SONETEL_OUTGOING_CALLER_ID");
  }

  return {
    provider: auth.provider,
    accountId: auth.accountId,
    outgoingCallerIdPresent: Boolean(auth.outgoingCallerId),
    call1DestinationPresent: Boolean(auth.call1Destination),
    call1DestinationValid,
    agentDestinationPresent: Boolean(auth.agentDestination),
    agentDestinationValid: isValidAgentDestinationFormat(auth.agentDestination),
    liveOutboundEnabled: auth.liveOutboundEnabled,
    liveOutboundReady: missingLiveOutboundConfig.length === 0,
    missingLiveOutboundConfig,
    callbackEndpoint: auth.callbackEndpoint
  };
}
