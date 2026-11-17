import { timingSafeEqual } from "node:crypto";
import type { ProviderAdapter } from "../adapters/base";
import { buildResponseJSON } from "../bridge";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute, type ChatGptWebAccountCapabilities } from "../chatgpt-web-models";
import type { AdapterEvent } from "../types";
import { BridgeError, prepareTurn } from "./envelope";

export interface HermesHandlerOptions {
  apiKey: string;
  capabilities: ChatGptWebAccountCapabilities;
  adapter: ProviderAdapter;
}

export function createHermesHandler(options: HermesHandlerOptions) {
  if (!options.apiKey.trim()) throw new Error("CHATGPT_WEB_API_KEY is required");
  return async (request: Request): Promise<Response> => {
    try {
      const expected = Buffer.from(`Bearer ${options.apiKey}`);
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeError("Unauthorized", 401);
      if (request.headers.has("origin") || request.headers.has("sec-fetch-mode")) throw new BridgeError("Browser requests are not allowed", 403);
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new BridgeError("Loopback requests only", 403);
      if (url.pathname === "/v1/models" && request.method === "GET") return Response.json({ object: "list", data:
        availableChatGptWebModelRoutes(options.capabilities).map(route => ({ id: route.slug, object: "model", created: 0, owned_by: "chatgpt-web" })) });
      if (url.pathname !== "/v1/responses") throw new BridgeError("Not found", 404);
      if (request.method !== "POST") throw new BridgeError("Method not allowed", 405);
      let body: Record<string, unknown>;
      try { body = await request.json(); } catch { throw new BridgeError("Invalid JSON request body"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("Request must be an object");
      const model = body.model;
      if (typeof model !== "string" || !availableChatGptWebModelRoutes(options.capabilities).some(route => route.slug === model)) throw new BridgeError("Model is not available in the configured browser account");
      let route;
      try { route = requireChatGptWebModelRoute(model, options.capabilities); } catch { throw new BridgeError("Model unavailable"); }
      if (route.interactionMode !== "automatic") throw new BridgeError("Manual browser mode is not supported by the Hermes bridge");
      const turn = prepareTurn(body);
      turn.parsed.modelId = route.backendModel;
      turn.parsed._chatgptModelFamily = route.modelFamily;
      turn.parsed.options.reasoning = route.adapterEffort;
      let text = "";
      let done: Extract<AdapterEvent, { type: "done" }> | undefined;
      await options.adapter.runTurn(turn.parsed, { headers: new Headers(), abortSignal: request.signal }, event => {
        if (event.type === "text_delta" && event.phase !== "commentary") text += event.text;
        else if (event.type === "done") done = event;
        else if (event.type === "error" || event.type === "incomplete") throw new BridgeError("Browser turn failed", 502);
      });
      if (!done) throw new BridgeError("Browser turn did not complete", 502);
      return Response.json(buildResponseJSON(turn.decode(text, done), model));
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 502;
      return Response.json({ error: { message: error instanceof BridgeError ? error.message : "Browser runtime failed", type: status >= 500 ? "server_error" : "invalid_request_error", code: status === 401 ? "invalid_api_key" : "bridge_error" } }, { status });
    }
  };
}
