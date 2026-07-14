// mesh-harness.mjs — deterministic conductor-mesh test client for aby-nevejo.
// All evidence of record lands in /tmp/conductor-bridge/<agentId>/events.jsonl;
// this script only orchestrates timing. Modes:
//   register-exit <id>            connect, hold 2s, close() cleanly (deregisters)
//   register-die  <id> <holdSec>  connect, hold, process.exit(1) — NO deregister (crash sim)
//   hold          <id> <holdSec>  connect, hold, then clean close (live-peer target for positive control)
//   send          <id> <target> <nonce> <k>   connect, send k sequenced msgs, wait 3s for errors, close
//   probe         <id> <waitSec>  connect as returning peer, sit, record replay/arrivals, close
import { ConductorBridge } from '../dist/conductor-bridge.js';

const [mode, id, ...rest] = process.argv.slice(2);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const bridge = new ConductorBridge({
  agentId: id,
  label: `${id} (harness)`,
  logFile: `/tmp/conductor-bridge/${id}/bridge.log`,
  fileName: id,
});

bridge.on('message', (from, message) => console.log(`ARRIVED from=${from}: ${message}`));
bridge.on('error', (e) => console.log(`ERROR: ${e}`));
bridge.on('connected', () => console.log(`CONNECTED as ${id}`));

await bridge.connect();

if (mode === 'register-exit') {
  await sleep(2);
  bridge.close();
  console.log('CLEAN-EXIT (deregistered)');
} else if (mode === 'register-die') {
  await sleep(Number(rest[0] ?? 3));
  console.log('DYING-UNCLEAN (no deregister)');
  process.exit(1);
} else if (mode === 'hold') {
  await sleep(Number(rest[0] ?? 30));
  bridge.close();
  console.log('HOLD-DONE');
} else if (mode === 'send') {
  const [target, nonce, k] = rest;
  await sleep(1);
  for (let i = 1; i <= Number(k); i++) {
    bridge.send(target, `${nonce} ${i}/${k}`);
    await sleep(0.5);
  }
  await sleep(3); // let conductor_error responses land in events.jsonl
  bridge.close();
  console.log(`SENT ${k} to ${target} nonce=${nonce}`);
} else if (mode === 'probe') {
  await sleep(Number(rest[0] ?? 6));
  bridge.close();
  console.log('PROBE-DONE');
} else {
  console.log(`unknown mode: ${mode}`);
  process.exit(2);
}
process.exit(0);
