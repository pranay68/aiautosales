import { executeSonetelOutboundCall } from "../services/dialer-service/src/sonetel-adapter";

const targetNumber = process.argv[2] ?? "+15551234567";
process.env.SONETEL_ENABLE_LIVE_OUTBOUND = "true";

try {
  const result = await executeSonetelOutboundCall({
    to: targetNumber,
    prospectId: "provider-validation"
  });

  console.log(
    JSON.stringify({
      ok: true,
      targetNumber,
      result
    })
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      targetNumber,
      message: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
}
