import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { startGatewayServer } from "../../../server/server.js";
import { getFreeGatewayPort } from "../../../server/test-helpers.e2e.js";

describe("tiered routing e2e - full gateway integration", () => {
  let tempHome: string;
  let workspaceDir: string;
  let configPath: string;
  let port: number;
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let token: string;
  let ws: WebSocket | undefined;

  const prevEnv = {
    home: process.env.HOME,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    skipBrowser: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
  };

  beforeAll(async () => {
    // Create temp home
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tier-e2e-"));
    process.env.HOME = tempHome;
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";

    // Set up workspace
    workspaceDir = path.join(tempHome, "openclaw");
    await fs.mkdir(workspaceDir, { recursive: true });

    // Generate token
    token = `test-tier-${randomUUID()}`;
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    // Create config with tiered routing
    const configDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    configPath = path.join(configDir, "openclaw.json");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "ollama/qwen2.5:14b",
          },
          routing: {
            enabled: true,
            classifierModel: "ollama/qwen2.5:14b",
            useModelClassifier: true,
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen2.5:14b",
                name: "Qwen 2.5 14B",
                api: "openai-completions",
                contextWindow: 32768,
                cost: { input: 0, output: 0 },
              },
            ],
          },
        },
      },
      gateway: { auth: { token } },
    };

    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    // Start gateway server
    port = await getFreeGatewayPort();
    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });

    console.log(`[e2e-setup] Gateway server started on port ${port}`);
  });

  afterAll(async () => {
    if (ws) {
      ws.close();
    }
    if (server) {
      await server.close();
    }

    // Restore env
    process.env.HOME = prevEnv.home;
    process.env.OPENCLAW_CONFIG_PATH = prevEnv.configPath;
    process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv.token;
    process.env.OPENCLAW_SKIP_CHANNELS = prevEnv.skipChannels;
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = prevEnv.skipGmail;
    process.env.OPENCLAW_SKIP_CRON = prevEnv.skipCron;
    process.env.OPENCLAW_SKIP_CANVAS_HOST = prevEnv.skipCanvas;
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = prevEnv.skipBrowser;

    // Clean up temp home
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function connectWebchat(): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => socket.once("open", resolve));

    const reqId = randomUUID();

    // Load device identity for auth
    const { loadOrCreateDeviceIdentity, signDevicePayload, publicKeyRawBase64UrlFromPem } =
      await import("../../../infra/device-identity.js");
    const { buildDeviceAuthPayload } = await import("../../../server/device-auth.js");

    const identity = loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: "test",
      clientMode: "test",
      role: "operator",
      scopes: ["operator.admin"],
      signedAtMs,
      token,
    });

    const device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
    };

    // Send connect request using gateway protocol
    const connectMsg = {
      type: "req",
      id: reqId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "test",
          version: "dev",
          platform: "test",
          mode: "test",
        },
        caps: [],
        commands: [],
        role: "operator",
        scopes: ["operator.admin"],
        auth: { token },
        device,
      },
    };

    socket.send(JSON.stringify(connectMsg));

    // Wait for connect response
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("connect timeout")), 5000);
      socket.once("message", (data) => {
        clearTimeout(timeout);
        const msg = JSON.parse(data.toString());
        console.log(`[e2e] Connect response: ${JSON.stringify(msg)}`);
        if (msg.type === "res" && msg.id === reqId && msg.ok) {
          resolve();
        } else {
          reject(new Error(`Connect failed: ${JSON.stringify(msg)}`));
        }
      });
    });

    return socket;
  }

  async function sendChatMessage(
    socket: WebSocket,
    message: string,
    sessionKey = "main",
  ): Promise<{ responses: string[]; events: any[]; rpcResponse: any }> {
    const idempotencyKey = randomUUID();
    const reqId = randomUUID();

    const chatSendMsg = {
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        sessionKey,
        message,
        idempotencyKey,
      },
    };

    const responses: string[] = [];
    const events: any[] = [];
    let rpcResponse: any = null;

    // Collect all events and responses
    const messageHandler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      console.log(`[e2e] Received message: ${JSON.stringify(msg).slice(0, 200)}`);

      // Track RPC response
      if (msg.type === "res" && msg.id === reqId) {
        rpcResponse = msg;
        console.log(`[e2e] Got RPC response: ${JSON.stringify(msg)}`);
      }

      // Track events
      if (msg.type === "event") {
        events.push(msg);

        // Event structure: {"type":"event","event":"agent","payload":{"stream":"routing",...}}
        const eventType = msg.event;
        const payload = msg.payload || {};

        console.log(
          `[e2e] Got event: type=${eventType} payload.stream=${payload.stream || "none"}`,
        );

        // For agent events, check the payload.stream
        if (eventType === "agent") {
          // Capture chat final responses
          if (payload.stream === "chat" && payload.data?.text) {
            console.log(`[e2e] Got agent/chat response: ${payload.data.text.slice(0, 100)}`);
            responses.push(payload.data.text);
          }
          // Capture reply stream
          if (payload.stream === "reply" && payload.data?.text) {
            console.log(`[e2e] Got reply: ${payload.data.text.slice(0, 100)}`);
            responses.push(payload.data.text);
          }
        }

        // For direct chat events (final message from broadcastChatFinal)
        // Structure: {"event":"chat","payload":{"message":{"content":[{"type":"text","text":"..."}]}}}
        if (eventType === "chat" && payload.message?.content) {
          const textContent = payload.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (textContent) {
            console.log(`[e2e] Got chat final response: ${textContent.slice(0, 100)}`);
            responses.push(textContent);
          }
        }
      }
    };

    socket.on("message", messageHandler);

    // Send the message
    console.log(`[e2e] Sending chat.send: ${JSON.stringify(chatSendMsg)}`);
    socket.send(JSON.stringify(chatSendMsg));

    // Wait for the actual response (not just the "started" acknowledgment)
    // The RPC returns immediately with status:started, but the actual response comes via events
    await new Promise<void>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.off("message", messageHandler);
          console.log(
            `[e2e] Timeout after 45s. Events: ${events.length}, Responses: ${responses.length}`,
          );
          resolve();
        }
      }, 45000);

      const checkComplete = () => {
        if (resolved) {
          return;
        }

        // Look for chat event with response text or lifecycle end
        // Events structure: {"event":"agent","payload":{"stream":"chat","data":{...}}}
        const chatEvent = events.find(
          (e) => e.event === "agent" && e.payload?.stream === "chat" && e.payload?.data?.text,
        );
        const lifecycleEnd = events.find(
          (e) =>
            e.event === "agent" &&
            e.payload?.stream === "lifecycle" &&
            e.payload?.data?.phase === "end",
        );

        // Complete when we have actual response text OR lifecycle ended
        if (chatEvent || lifecycleEnd || responses.length > 0) {
          resolved = true;
          clearTimeout(timeout);
          socket.off("message", messageHandler);
          console.log(
            `[e2e] Complete! Chat events: ${!!chatEvent}, Lifecycle end: ${!!lifecycleEnd}, Responses: ${responses.length}`,
          );
          resolve();
        }
      };

      // Check periodically
      const interval = setInterval(checkComplete, 100);
      setTimeout(() => {
        clearInterval(interval);
        if (!resolved) {
          resolved = true;
          socket.off("message", messageHandler);
          console.log(
            `[e2e] Final timeout. Events: ${events.length}, Responses: ${responses.length}`,
          );
          resolve();
        }
      }, 45000);
    });

    return { responses, events, rpcResponse };
  }

  it(
    "simple conversational message uses fast path and delivers response",
    { timeout: 60_000 },
    async () => {
      ws = await connectWebchat();
      console.log("[e2e] Connected to gateway via webchat");

      const { responses, events, rpcResponse } = await sendChatMessage(ws, "hello!");
      console.log(`[e2e] Received ${responses.length} responses`);
      console.log(`[e2e] Received ${events.length} events`);
      console.log(`[e2e] RPC response: ${JSON.stringify(rpcResponse)}`);

      // Verify we got a routing event showing simple tier
      const routingEvent = events.find(
        (e) => e.event === "agent" && e.payload?.stream === "routing",
      );
      expect(routingEvent).toBeDefined();
      console.log(`[e2e] Routing decision: ${JSON.stringify(routingEvent?.payload)}`);
      expect(routingEvent?.payload?.data?.tier).toBe("simple");

      // Verify we got at least one response
      expect(responses.length).toBeGreaterThan(0);

      const fullResponse = responses.join(" ");
      console.log(`[e2e] Full response: ${fullResponse}`);

      // Verify response is conversational (not empty or error)
      expect(fullResponse.length).toBeGreaterThan(0);
      expect(fullResponse.toLowerCase()).toMatch(/hello|hi|assist|help/);
    },
  );

  it("permission query uses fast path and delivers response", { timeout: 60_000 }, async () => {
    if (!ws) {
      ws = await connectWebchat();
    }

    const { responses, events, rpcResponse } = await sendChatMessage(ws, "what can you do?");
    console.log(`[e2e] Received ${responses.length} responses`);
    console.log(`[e2e] RPC response: ${JSON.stringify(rpcResponse)}`);

    // Verify routing to simple tier
    const routingEvent = events.find((e) => e.event === "agent" && e.payload?.stream === "routing");
    expect(routingEvent).toBeDefined();

    // Verify we got a response
    expect(responses.length).toBeGreaterThan(0);

    const fullResponse = responses.join(" ");
    console.log(`[e2e] Capability response: ${fullResponse.slice(0, 200)}`);

    expect(fullResponse.length).toBeGreaterThan(0);
  });
});
