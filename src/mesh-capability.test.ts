/**
 * mesh-capability.test.ts — the send-only/bidirectional detector (aby-masogo).
 *
 * Pure function over (env, parent argv), so every shape the estate produces is
 * testable offline. The fixtures below are REAL cmdlines and env values measured
 * on tube 2026-07-26, not invented ones — including the --settings JSON blob the
 * claudev/claudefv wrappers pass, which is why the flag test matches argv tokens
 * exactly rather than searching for a substring.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectMeshCapability, CHANNELS_FLAG } from "./mesh-capability.js";

// Measured: the wrapper embeds billing config as one argv element.
const SETTINGS_BLOB = '{"env":{"CLAUDE_CODE_USE_VERTEX":"1","CLOUD_ML_REGION":"global"}}';
const TEAMS_INTERACTIVE = { CLAUDE_CODE_ENTRYPOINT: "cli" } as NodeJS.ProcessEnv;

describe("detectMeshCapability (aby-masogo)", () => {
  it("flag-born interactive Teams session can receive", () => {
    const cap = detectMeshCapability(TEAMS_INTERACTIVE, ["claude", CHANNELS_FLAG, "plugin:sonnette@batterie"]);
    assert.equal(cap.canReceive, true, cap.detail);
    assert.equal(cap.reason, undefined);
  });

  it("plain interactive session is send-only (no flag)", () => {
    const cap = detectMeshCapability(TEAMS_INTERACTIVE, ["claude"]);
    assert.equal(cap.canReceive, false);
    assert.equal(cap.reason, "no-flag");
  });

  it("Vertex session is send-only even when flag-born", () => {
    const cap = detectMeshCapability(
      { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_VERTEX: "1" },
      ["claude", CHANNELS_FLAG, "server:conductor-channel"],
    );
    assert.equal(cap.canReceive, false);
    assert.equal(cap.reason, "vertex", "provider gate must bite before the flag check");
  });

  it("headless -p is send-only even when flag-born on Teams", () => {
    // Measured: `claude -p` reports entrypoint sdk-cli. Both signals asserted.
    const byEntrypoint = detectMeshCapability(
      { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
      ["claude", "-p", "prompt", CHANNELS_FLAG, "server:conductor-channel"],
    );
    assert.equal(byEntrypoint.canReceive, false);
    assert.equal(byEntrypoint.reason, "headless");

    // Backstop: a launcher that leaves entrypoint as cli but passes -p.
    const byArgv = detectMeshCapability(TEAMS_INTERACTIVE, ["claude", "-p", "prompt", CHANNELS_FLAG]);
    assert.equal(byArgv.canReceive, false);
    assert.equal(byArgv.reason, "headless");
  });

  it("resumed flag-born session is send-only (aby-wodagu)", () => {
    for (const resumeFlag of ["-c", "--continue", "--resume"]) {
      const cap = detectMeshCapability(TEAMS_INTERACTIVE, ["claude", resumeFlag, CHANNELS_FLAG]);
      assert.equal(cap.canReceive, false, `${resumeFlag} should be send-only`);
      assert.equal(cap.reason, "resumed");
    }
  });

  it("does not match the flag inside a --settings JSON blob", () => {
    // Exact-token discipline: a substring search over the joined cmdline would
    // false-positive on any argv element that merely CONTAINS the flag text.
    const sneaky = `{"note":"${CHANNELS_FLAG} is not set here"}`;
    const cap = detectMeshCapability(TEAMS_INTERACTIVE, ["claude", "--settings", sneaky]);
    assert.equal(cap.canReceive, false);
    assert.equal(cap.reason, "no-flag");
  });

  it("real measured tube cmdline (Vertex wrapper, no flag) is send-only", () => {
    const cap = detectMeshCapability(
      { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_VERTEX: "1" },
      ["claude", "--settings", SETTINGS_BLOB, "/open"],
    );
    assert.equal(cap.canReceive, false);
    assert.equal(cap.reason, "vertex");
  });

  it("unreadable parent argv falls back to send-only, never to a false receive claim", () => {
    const cap = detectMeshCapability(TEAMS_INTERACTIVE, []);
    assert.equal(cap.canReceive, false, "an unknown must never be reported as receive-capable");
    assert.equal(cap.reason, "no-flag");
  });

  it("Desktop entrypoint is send-only (never measured surfacing tags)", () => {
    const cap = detectMeshCapability({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, ["claude", CHANNELS_FLAG]);
    assert.equal(cap.canReceive, false);
    assert.equal(cap.reason, "headless");
  });
});
