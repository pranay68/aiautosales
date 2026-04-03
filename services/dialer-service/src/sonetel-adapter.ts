import { loadEnv } from "@aiautosales/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

type CurlJsonResponse = {
  statusCode: number;
  bodyText: string;
  bodyJson: unknown;
};

async function requestJsonWithCurl(input: {
  method: "POST" | "PUT";
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<CurlJsonResponse> {
  const statusMarker = "__SONETEL_HTTP_STATUS__";

  if (process.platform === "win32") {
    const args = [
      "-sS",
      "--noproxy",
      "*",
      "-X",
      input.method,
      ...Object.entries(input.headers).flatMap(([key, value]) => ["-H", `${key}: ${value}`]),
      "--data-raw",
      JSON.stringify(input.body),
      "-w",
      `\\n${statusMarker}:%{http_code}`,
      input.endpoint
    ];

    const { stdout } = await execFileAsync("curl", args, { maxBuffer: 1024 * 1024 });
    const markerIndex = stdout.lastIndexOf(statusMarker);
    if (markerIndex < 0) {
      throw new Error(`Sonetel curl request did not return an HTTP status marker: ${stdout}`);
    }

    const bodyText = stdout.slice(0, markerIndex).trim();
    const statusText = stdout.slice(markerIndex + statusMarker.length + 1).trim();
    const statusCode = Number.parseInt(statusText, 10);

    let bodyJson: unknown = undefined;
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = bodyText;
      }
    }

    return {
      statusCode: Number.isNaN(statusCode) ? 0 : statusCode,
      bodyText,
      bodyJson
    };
  }

  const shellQuote = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;
  const payload = input.body;
  const jqPayloadCommand = [
    "jq -nc",
    "--arg app_id",
    shellQuote(String(payload.app_id ?? "")),
    "--arg call1",
    shellQuote(String(payload.call1 ?? "")),
    "--arg call2",
    shellQuote(String(payload.call2 ?? "")),
    "--arg show_1",
    shellQuote(String(payload.show_1 ?? "")),
    "--arg show_2",
    shellQuote(String(payload.show_2 ?? "")),
    "'{app_id:$app_id,call1:$call1,call2:$call2,show_1:$show_1,show_2:$show_2}'"
  ].join(" ");
  const command = [
    `payload=$(${jqPayloadCommand});`,
    "curl -sS --noproxy '*'",
    "-X",
    input.method,
    ...Object.entries(input.headers).flatMap(([key, value]) => ["-H", shellQuote(`${key}: ${value}`)]),
    "--data-raw",
    "\"$payload\"",
    "-w",
    shellQuote(`\\n${statusMarker}:%{http_code}`),
    shellQuote(input.endpoint)
  ].join(" ");

  const { stdout } = await execFileAsync("bash", ["-lc", command], { maxBuffer: 1024 * 1024 });
  const markerIndex = stdout.lastIndexOf(statusMarker);
  if (markerIndex < 0) {
    throw new Error(`Sonetel curl request did not return an HTTP status marker: ${stdout}`);
  }

  const bodyText = stdout.slice(0, markerIndex).trim();
  const statusText = stdout.slice(markerIndex + statusMarker.length + 1).trim();
  const statusCode = Number.parseInt(statusText, 10);

  let bodyJson: unknown = undefined;
  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = bodyText;
    }
  }

  return {
    statusCode: Number.isNaN(statusCode) ? 0 : statusCode,
    bodyText,
    bodyJson
  };
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

export async function buildSonetelAuthContext(): Promise<SonetelAuthContext> {
  const env = loadEnv();
  const accessToken = await getSonetelAccessToken();
  const accountId = env.sonetelAccountId || deriveSonetelAccountId(accessToken);
  const userId = deriveSonetelUserId(accessToken);

  return {
    provider: "sonetel" as const,
    apiBaseUrl: env.sonetelApiBaseUrl,
    accessToken,
    accountId,
    userId,
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
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "aiautosales/1.0"
    },
    payload: {
      app_id: `aiautosales:${input.prospectId}`,
      call1: auth.agentDestination,
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
  ensureLiveOutboundReady(auth);

  const endpoint = getCallForwardingEndpoint(auth.apiBaseUrl, auth.accountId, auth.outgoingCallerId);
  const payload = {
    connect_to_type: "user",
    connect_to: auth.userId
  };

  const response = await requestJsonWithCurl({
    method: "PUT",
    endpoint,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: payload
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Sonetel call forwarding update failed with status ${response.statusCode}: ${JSON.stringify(response.bodyJson ?? response.bodyText)}`
    );
  }

  return { endpoint, payload, rawResponse: response.bodyJson };
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
  const forwarding = isEmailDestination(auth.agentDestination)
    ? undefined
    : await syncSonetelAgentForwarding();

  const response = await requestJsonWithCurl({
    method: "POST",
    endpoint: request.endpoint,
    headers: request.headers,
    body: request.payload
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Sonetel outbound call failed with status ${response.statusCode}: ${JSON.stringify(response.bodyJson ?? response.bodyText)}`
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
