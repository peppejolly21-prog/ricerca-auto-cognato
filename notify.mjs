// Sends Web Push notifications to stored subscriptions.
// Usage: node notify.mjs <subscriptions.json> <payload.json>
// subscriptions.json: array of PushSubscription objects (endpoint, keys.p256dh, keys.auth)
// payload.json: { title, body, url }

import webpush from "web-push";
import { readFileSync } from "fs";

const vapid = JSON.parse(readFileSync(new URL("./vapid_keys.json", import.meta.url)));
webpush.setVapidDetails("mailto:luisogiuseppe89@hotmail.com", vapid.publicKey, vapid.privateKey);

const [, , subsFile, payloadFile] = process.argv;
if (!subsFile || !payloadFile) {
  console.error("Usage: node notify.mjs <subscriptions.json> <payload.json>");
  process.exit(1);
}

const subscriptions = JSON.parse(readFileSync(subsFile, "utf8"));
const payload = JSON.parse(readFileSync(payloadFile, "utf8"));

let sent = 0;
let failed = 0;

for (const sub of subscriptions) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    sent++;
  } catch (e) {
    failed++;
    console.error(`Failed for endpoint ${sub.endpoint ? sub.endpoint.slice(0, 50) : "?"}: ${e.statusCode || ""} ${e.message}`);
  }
}

console.log(`Sent: ${sent}, Failed: ${failed}`);
