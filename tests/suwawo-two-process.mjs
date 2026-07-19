// aby-suwawo regression test — same-id double-server war.
//
// Why a standalone script and not a bun/node unit test: the fix keys on process
// AGE (birthMs) + pid to decide which of two same-id servers yields, so the two
// servers MUST be separate OS processes. A single-process unit test can't
// reproduce it. This drives ONE ConductorBridge + a conductor-channel-style
// health check per process; launch two copies with the same agentId.
//
// It talks to the REAL mesh (needs ~/.claude/.credentials.json), so it lives in
// tests/ (vendor-excluded) and is run by hand, not in CI.
//
// Usage (run from the repo root):
//   ID="cc-suwawo-$(date +%s)"
//   bun tests/suwawo-two-process.mjs "$ID" A 16 >/tmp/A.log 2>&1 &
//   sleep 1; bun tests/suwawo-two-process.mjs "$ID" B 16 >/tmp/B.log 2>&1 & wait
//   # PASS: connects small (not climbing); exactly the YOUNGER process logs
//   #       YIELDED-PERMANENTLY; the older survives. (Pre-fix: ~8 connects each.)
//
// Tarafo-revive regression (older survivor must NOT yield when a younger
// superseder dies): launch A, sleep 2, launch B, sleep 5, `kill -9` B, wait.
//   # PASS: A logs a 2nd CONNECTED and ZERO YIELDED — it revived, didn't yield.
import { ConductorBridge } from "../src/conductor-bridge.js";

const agentId = process.argv[2];
const label = process.argv[3];
const lifetime = parseInt(process.argv[4] || "20", 10) * 1000;
const HC = 2000; // fast health check for a quick test (real conductor-channel is 10s)

const b = new ConductorBridge({ agentId, label });
let connects = 0;
b.on("connected", () => { connects++; console.log(`[${label} pid=${process.pid}] CONNECTED #${connects}`); });
await b.connect();

const hc = setInterval(() => {
  if (b.isPermanentlyYielded) {
    console.log(`[${label} pid=${process.pid}] YIELDED-PERMANENTLY — stopping health check`);
    clearInterval(hc);
    return;
  }
  if (b.isClosed) {
    console.log(`[${label} pid=${process.pid}] closed → reconnect()`);
    b.reconnect().catch(() => {});
  }
}, HC);

setTimeout(() => {
  clearInterval(hc);
  b.close();
  console.log(`[${label} pid=${process.pid}] DONE connects=${connects}`);
  process.exit(0);
}, lifetime);
