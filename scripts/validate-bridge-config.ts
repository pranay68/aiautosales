import { loadEnv } from "@aiautosales/config";

const env = loadEnv();
const missing: string[] = [];

if (!env.sonetelAgentDestination) {
  missing.push("SONETEL_AGENT_DESTINATION");
}
if (env.sonetelAgentDestination && /^https?:\/\//i.test(env.sonetelAgentDestination)) {
  missing.push("SONETEL_AGENT_DESTINATION_FORMAT");
}

if (!env.sonetelOutgoingCallerId) {
  missing.push("SONETEL_OUTGOING_CALLER_ID");
}

console.log(
  JSON.stringify({
    ok: missing.length === 0,
    bridgeGatewayPort: env.bridgeGatewayPort,
    bridgeGatewayPublicBaseUrlPresent: Boolean(env.bridgeGatewayPublicBaseUrl),
    sonetelAgentDestinationPresent: Boolean(env.sonetelAgentDestination),
    sonetelAgentDestinationValid: Boolean(env.sonetelAgentDestination) && !/^https?:\/\//i.test(env.sonetelAgentDestination),
    missing
  })
);

if (missing.length > 0) {
  process.exit(1);
}
