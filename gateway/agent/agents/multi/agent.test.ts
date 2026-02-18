/**
 * Multi agent unit tests.
 * Verifies pi config, tool allowlist, and agent definition.
 */

import { describe, expect, it } from "vitest";
import { getAgentPiConfig } from "../pi-registry.js";
import { MULTI_AGENT_ID, MULTI_PI_CONFIG } from "./agent.js";

describe("MultiAgent", () => {
  it("has MULTI_AGENT_ID", () => {
    expect(MULTI_AGENT_ID).toBe("multi");
  });

  it("has pi config with session tools only", () => {
    expect(MULTI_PI_CONFIG.preset).toBe("minimal");
    expect(MULTI_PI_CONFIG.tools?.allow).toEqual([
      "sessions_spawn",
      "sessions_list",
      "sessions_send",
      "session_status",
    ]);
    expect(MULTI_PI_CONFIG.skills).toBe(false);
  });

  it("does not allow exec, read, or write", () => {
    const allow = MULTI_PI_CONFIG.tools?.allow ?? [];
    expect(allow).not.toContain("exec");
    expect(allow).not.toContain("read");
    expect(allow).not.toContain("write");
  });

  it("is registered in pi-registry", () => {
    const config = getAgentPiConfig("multi");
    expect(config).toBeDefined();
    expect(config).toEqual(MULTI_PI_CONFIG);
  });

  it("has SOUL and TOOLS bootstrap files", () => {
    expect(MULTI_PI_CONFIG.bootstrapFiles).toContain("SOUL");
    expect(MULTI_PI_CONFIG.bootstrapFiles).toContain("TOOLS");
  });
});
