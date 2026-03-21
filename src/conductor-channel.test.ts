/**
 * conductor-channel.test.ts — Tests for the Channels MCP server.
 *
 * These test the channel server process lifecycle, not the MCP protocol
 * (which requires a live CC session). We verify:
 * - Exits cleanly (code 0) when MESH_AGENT_ID is absent
 * - Starts and connects when MESH_AGENT_ID is set (requires network)
 */

import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";

const CHANNEL_SCRIPT = join(import.meta.dirname, "conductor-channel.js");

describe("conductor-channel", () => {
  it("exits cleanly (code 0) when MESH_AGENT_ID is absent", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const proc = spawn("node", [CHANNEL_SCRIPT], {
        env: { ...process.env, MESH_AGENT_ID: "", MESH_ROLE: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      // Close stdin immediately — simulates CC not being connected
      proc.stdin?.end();

      proc.on("exit", (code) => {
        resolve({ code, stderr });
      });

      // Safety timeout
      setTimeout(() => {
        proc.kill("SIGTERM");
      }, 5000);
    });

    assert.equal(result.code, 0, `Expected exit code 0, got ${result.code}. stderr: ${result.stderr}`);
  });

  it("starts bridge when MESH_AGENT_ID is set and exits on stdin close", async () => {
    // This test requires network access (connects to conductor mesh).
    // It verifies the server starts, then exits cleanly when stdin closes
    // (simulating CC shutdown).
    const result = await new Promise<{ code: number | null; stderr: string; duration: number }>((resolve) => {
      const start = Date.now();
      const proc = spawn("node", [CHANNEL_SCRIPT], {
        env: {
          ...process.env,
          MESH_AGENT_ID: "cc-test-channel-lifecycle",
          MESH_ROLE: "user",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      // Give it 3s to connect, then close stdin to trigger shutdown
      setTimeout(() => {
        proc.stdin?.end();
      }, 3000);

      proc.on("exit", (code) => {
        resolve({ code, stderr, duration: Date.now() - start });
      });

      // Safety timeout
      setTimeout(() => {
        proc.kill("SIGTERM");
      }, 15000);
    });

    assert.equal(result.code, 0, `Expected clean exit, got code ${result.code}. stderr: ${result.stderr}`);
    assert.ok(result.duration >= 3000, `Expected at least 3s runtime, got ${result.duration}ms`);
  });
});
