import fs from "node:fs";
import { buildSonetelAuthContext } from "../services/dialer-service/src/sonetel-adapter";

const envPath = ".env";

function setEnvValue(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, "m").test(contents)) {
    return contents.replace(new RegExp(`^${key}=.*$`, "m"), line);
  }

  return `${contents.trimEnd()}\n${line}\n`;
}

const auth = await buildSonetelAuthContext();
let envContents = fs.readFileSync(envPath, "utf8");
envContents = setEnvValue(envContents, "SONETEL_ACCESS_TOKEN", auth.accessToken);
envContents = setEnvValue(envContents, "SONETEL_ACCOUNT_ID", auth.accountId);
fs.writeFileSync(envPath, envContents);

console.log(
  JSON.stringify({
    ok: true,
    accountId: auth.accountId,
    outgoingCallerIdPresent: Boolean(auth.outgoingCallerId),
    agentDestinationPresent: Boolean(auth.agentDestination)
  })
);
