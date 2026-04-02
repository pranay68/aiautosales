import { validateSonetelConfiguration } from "../services/dialer-service/src/sonetel-adapter";

try {
  const result = await validateSonetelConfiguration();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
}
