/**
 * mesh-id-seam.test.ts — drift-guard for the two-language mesh-id derivation.
 *
 * The mesh identity is computed in TWO places that MUST agree, or the statusline
 * glyph silently goes dark for a live session (aby-pupaso family):
 *   - TypeScript: meshAgentId() in mesh-id.ts (used by conductor-channel.ts)
 *   - bash:       statusline.sh, when MESH_AGENT_ID is unset, derives
 *                 cc-${dir}-${first8 of CLAUDE_CODE_SESSION_ID}
 *
 * Test 1 pins the TS formula to literals (catches TS-side drift).
 * Test 2 runs the REAL statusline.sh against a fixture bridge dir and asserts it
 *         emits the SAME id meshAgentId() produces (catches bash↔TS drift).
 *
 * The seam test needs ~/.claude/statusline.sh (the bash side lives outside this
 * repo); it skips gracefully where that file isn't present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { meshAgentId } from "./mesh-id.js";

const STATUSLINE = join(process.env.HOME ?? "", ".claude", "statusline.sh");

// Deliberately fake folders/uuids so the fixture bridge dirs can never collide
// with — or delete — a real session's /tmp/conductor-bridge entry. "widget-x"
// exercises a hyphenated folder (the id then has multiple '-'; the statusline
// strips only the leading "cc-").
const FIXTURES = [
  { folder: "seamtest", uuid: "aaaaaaaa-1111-2222-3333-444455556666", expect: "cc-seamtest-aaaaaaaa" },
  { folder: "widget-x", uuid: "bcdef012-0000-0000-0000-000000000000", expect: "cc-widget-x-bcdef012" },
];

test("meshAgentId formula is cc-{folder}-{first8} (pins the TS side)", () => {
  for (const f of FIXTURES) {
    assert.equal(meshAgentId(f.folder, f.uuid), f.expect);
  }
});

test("statusline.sh derives the SAME id as meshAgentId (the seam)", (t) => {
  if (!existsSync(STATUSLINE)) {
    t.skip(`statusline.sh not found at ${STATUSLINE} — bash side of the seam unavailable here`);
    return;
  }
  for (const f of FIXTURES) {
    const id = meshAgentId(f.folder, f.uuid); // e.g. cc-seamtest-aaaaaaaa
    const dir = join("/tmp/conductor-bridge", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status"), "connected");
    writeFileSync(join(dir, "peers.json"), "{}");
    try {
      // Omit context_window so statusline re-latches current_dir every render
      // (dir = basename(current_dir)); its basename is our test folder.
      const stdin = JSON.stringify({
        model: { display_name: "Claude Test" },
        workspace: { current_dir: `/seamtest/${f.folder}` },
      });
      const out = execFileSync("bash", [STATUSLINE], {
        input: stdin,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: f.uuid, MESH_AGENT_ID: "" },
        encoding: "utf8",
      });
      // The mesh block renders "${mesh_id#cc-}" — the id minus the leading cc-.
      const rendered = id.replace(/^cc-/, "");
      assert.ok(
        out.includes(rendered),
        `statusline did not emit "${rendered}" — bash derivation drifted from meshAgentId().\nOutput: ${JSON.stringify(out)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
