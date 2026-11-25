import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import freerouterExtension from "./index.js";

function makePi() {
  let providerConfig: any;
  const handlers = new Map<string, any>();
  let setModelCalls = 0;

  return {
    pi: {
      registerProvider: (_name: string, config: any) => {
        providerConfig = config;
      },
      on: (event: string, handler: any) => {
        handlers.set(event, handler);
      },
      setModel: async () => {
        setModelCalls += 1;
      },
    } as any,
    get providerConfig() {
      return providerConfig;
    },
    get sessionStartHandler() {
      return handlers.get("session_start");
    },
    get sessionShutdownHandler() {
      return handlers.get("session_shutdown");
    },
    get setModelCalls() {
      return setModelCalls;
    },
  };
}

async function collectEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("freerouter extension startup", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    // Point pi at an empty folder so tests never read the real saved keys.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "freerouter-test-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  it("registers the provider when OPENROUTER_API_KEY is missing", async () => {
    const fakePi = makePi();
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run during startup");
    };

    await freerouterExtension(fakePi.pi);

    assert.equal(fetchCalls, 0);
    assert.equal(fakePi.providerConfig.apiKey, "pi-freerouter-selectable-placeholder");
    assert.equal(fakePi.providerConfig.api, "freerouter");
    assert.equal(fakePi.providerConfig.models[0].id, "auto");
    assert.equal(fakePi.providerConfig.models[0].name, "FreeRouter Auto");
    assert.equal(typeof fakePi.providerConfig.streamSimple, "function");
    assert.equal(fakePi.sessionStartHandler, undefined);
    assert.equal(fakePi.setModelCalls, 0);
  });

  it("passes Pi provider validation when OPENROUTER_API_KEY is missing", async () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const fakePi = {
      registerProvider: registry.registerProvider.bind(registry),
      on: () => {},
      setModel: async () => {},
    } as any;

    await freerouterExtension(fakePi);

    const model = registry.find("free-router", "auto");
    assert.equal(model?.id, "auto");
    assert.equal(model?.provider, "free-router");
    assert.ok(model);
    assert.equal(model.api, "freerouter");
    assert.equal(registry.hasConfiguredAuth(model), true);
  });

  it("returns a request-time error when OPENROUTER_API_KEY is missing", async () => {
    const fakePi = makePi();
    await freerouterExtension(fakePi.pi);

    const stream = fakePi.providerConfig.streamSimple(
      undefined,
      { messages: [] },
    ) as AsyncIterable<any>;
    const events = await collectEvents(stream);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].error.errorMessage, /OPENROUTER_API_KEY/);
  });

  it("uses the key pi passes in when OPENROUTER_API_KEY is missing", async () => {
    const fakePi = makePi();
    await freerouterExtension(fakePi.pi);
    let authHeader: string | undefined;
    globalThis.fetch = async (_url: any, init?: any) => {
      authHeader = new Headers(init?.headers).get("authorization") ?? undefined;
      throw new Error("stop after first call");
    };

    const stream = fakePi.providerConfig.streamSimple(
      undefined,
      { messages: [] },
      { apiKey: "sk-or-saved-in-pi" },
    ) as AsyncIterable<any>;
    await collectEvents(stream);

    assert.equal(authHeader, "Bearer sk-or-saved-in-pi");
  });

  it("falls back to pi's saved openrouter key", async () => {
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-from-auth-json" } }),
    );
    const fakePi = makePi();
    await freerouterExtension(fakePi.pi);
    let authHeader: string | undefined;
    globalThis.fetch = async (_url: any, init?: any) => {
      authHeader = new Headers(init?.headers).get("authorization") ?? undefined;
      throw new Error("stop after first call");
    };

    const stream = fakePi.providerConfig.streamSimple(
      undefined,
      { messages: [] },
      { apiKey: "pi-freerouter-selectable-placeholder" },
    ) as AsyncIterable<any>;
    await collectEvents(stream);

    assert.equal(authHeader, "Bearer sk-or-from-auth-json");
  });

  it("does not mark progress partials as errors before a successful response", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openai/gpt-oss-20b:free", name: "GPT OSS", context_length: 128000 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
              "data: [DONE]\n\n",
            ].join(""),
          ));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const fakePi = makePi();
    await freerouterExtension(fakePi.pi);
    const events = await collectEvents(fakePi.providerConfig.streamSimple(
      undefined,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    ));

    const progressPartials = events
      .filter((event) => event.type !== "error")
      .map((event) => event.partial)
      .filter(Boolean);
    assert.ok(progressPartials.length > 0);
    assert.equal(progressPartials.some((partial) => partial.stopReason === "error"), false);
  });

  it("registers session_shutdown hook to clear the refresh timer", async () => {
    const fakePi = makePi();
    await freerouterExtension(fakePi.pi);

    assert.ok(fakePi.sessionShutdownHandler, "sessionShutdownHandler was not registered");
    await fakePi.sessionShutdownHandler({ type: "session_shutdown", reason: "quit" });
  });
});
