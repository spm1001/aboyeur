/**
 * mesh-id.ts — the mesh agent-id formula, the ONE source of truth.
 *
 * Kept side-effect-free (no imports, no top-level code) so it can be imported by
 * both conductor-channel.ts and mesh-id-seam.test.ts without triggering mesh
 * startup. statusline.sh recomputes this SAME string in bash
 * (cc-${dir}-${first8 of CLAUDE_CODE_SESSION_ID}); mesh-id-seam.test.ts asserts
 * the two stay in step. Change the formula here → change statusline.sh → the
 * test proves they still agree. Diverge and the glyph silently goes dark.
 */
export function meshAgentId(folder: string, sessionUuid: string): string {
  return `cc-${folder}-${sessionUuid.slice(0, 8)}`;
}
