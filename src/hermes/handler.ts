import { timingSafeEqual } from "node:crypto";
import type { ProviderAdapter } from "../adapters/base";
import { bridgeToResponsesSSE, buildResponseJSON } from "../bridge";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute, type ChatGptWebAccountCapabilities } from "../chatgpt-web-models";
import { AsyncEventQueue } from "../event-queue";
import type { AdapterEvent } from "../types";
import { BridgeError, prepareTurn } from "./envelope";
import { validateRequest } from "./request";

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const headers = { "Cache-Control": "no-store", "x-should-retry": "false", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const loopback = (hostname: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);

export interface HermesHandlerOptions {
  apiKey: string;
  capabilities: ChatGptWebAccountCapabilities;
  adapter: ProviderAdapter;
  modelAllowlist?: readonly string[];
  maxBodyBytes?: number;
  maxReplyBytes?: number;
  heartbeatMs?: number;
  stallTimeoutSec?: number;
}

async function readBody(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new BridgeError("Content-Type must be application/json", 415);
  }
  if (![null, "identity"].includes(request.headers.get("content-encoding"))) throw new BridgeError("Content-Encoding is unsupported", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new BridgeError("Invalid Content-Length");
  if (declared !== null && Number(declared) > limit) throw new BridgeError("Request body too large", 413);
  if (!request.body) throw new BridgeError("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new BridgeError("Request body too large", 413);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new BridgeError("Invalid JSON request body"); }
}

export function createHermesHandler(options: HermesHandlerOptions) {
  if (!options.apiKey.trim()) throw new Error("CHATGPT_WEB_API_KEY is required");
  if (options.capabilities.browserInteractionMode === "manual") throw new Error("Hermes supports automatic browser mode only");
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxReply = options.maxReplyBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBody) || maxBody <= 0 || !Number.isSafeInteger(maxReply) || maxReply <= 0) throw new Error("Body and reply limits must be positive integers");
  const available = availableChatGptWebModelRoutes(options.capabilities);
  if (options.modelAllowlist?.some(model => !available.some(route => route.slug === model))) throw new Error("Model allowlist contains an unavailable browser model");
  const routes = available.filter(route => !options.modelAllowlist || options.modelAllowlist.includes(route.slug));
  const expected = Buffer.from(`Bearer ${options.apiKey}`);
  return async (request: Request): Promise<Response> => {
    try {
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeError("Unauthorized", 401);
      if (request.headers.has("origin") || [...request.headers.keys()].some(name => name.startsWith("sec-fetch-"))) throw new BridgeError("Browser requests are not allowed", 403);
      const url = new URL(request.url);
      if (!loopback(url.hostname) || url.protocol !== "http:" || url.username || url.password) throw new BridgeError("Loopback requests only", 403);
      const host = request.headers.get("host");
      if (host && host.toLowerCase() !== url.host.toLowerCase()) throw new BridgeError("Invalid loopback authority", 403);
      if (url.search) throw new BridgeError("Query parameters are unsupported");
      if (url.pathname === "/v1/models") {
        if (request.method !== "GET") throw new BridgeError("Method not allowed", 405);
        return json({ object: "list", data: routes.map(route => ({ id: route.slug, object: "model", created: 0, owned_by: "chatgpt-web" })) });
      }
      if (url.pathname !== "/v1/responses") throw new BridgeError("Not found", 404);
      if (request.method !== "POST") throw new BridgeError("Method not allowed", 405);
      const body = validateRequest(await readBody(request, maxBody));
      const model = body.model as string;
      if (!routes.some(route => route.slug === model)) throw new BridgeError("Model is not available in the configured browser account");
      let route;
      try { route = requireChatGptWebModelRoute(model, options.capabilities, (body.reasoning as { effort?: string } | null)?.effort); }
      catch { throw new BridgeError("Model or reasoning effort is unavailable for the configured browser account"); }
      if (route.interactionMode !== "automatic") throw new BridgeError("Manual browser mode is not supported by the Hermes bridge");
      const turn = prepareTurn(body);
      turn.parsed.modelId = route.backendModel;
      turn.parsed._chatgptModelFamily = route.modelFamily;
      turn.parsed.options.reasoning = route.adapterEffort;
      const abort = new AbortController();
      const signal = AbortSignal.any([request.signal, abort.signal]);
      const run = async (heartbeat: () => void = () => {}): Promise<AdapterEvent[]> => {
        let text = "";
        let textBytes = 0;
        let done: Extract<AdapterEvent, { type: "done" }> | undefined;
        signal.throwIfAborted();
        await options.adapter.runTurn(turn.parsed, { headers: new Headers(), abortSignal: signal }, event => {
          if (signal.aborted) return;
          if (event.type === "heartbeat") { heartbeat(); return; }
          if (event.type === "text_delta" && event.phase !== "commentary") {
            textBytes += Buffer.byteLength(event.text);
            if (textBytes > maxReply) throw new BridgeError("Browser reply exceeds the bridge output limit", 502);
            text += event.text;
          } else if (event.type === "done") done = event;
          else if (event.type === "error" || event.type === "incomplete") throw new BridgeError("Browser turn failed; acceptance or completion may be unknown. Do not automatically retry.", 502);
          else if (event.type === "tool_call_start" || event.type === "tool_call_delta" || event.type === "tool_call_end") throw new BridgeError("Browser engine attempted native tool output instead of the Hermes envelope", 502);
        });
        signal.throwIfAborted();
        if (!done) throw new BridgeError("Browser turn did not complete", 502);
        return turn.decode(text, done);
      };
      if (body.stream === true) {
        const queue = new AsyncEventQueue<AdapterEvent>(2048);
        const close = () => queue.close();
        signal.addEventListener("abort", close, { once: true });
        // Forward only progress until the entire reply envelope has been validated.
        void run(() => {
          try { queue.push({ type: "heartbeat" }); }
          catch { abort.abort(); }
        }).then(events => { for (const event of events) queue.push(event); }).catch(error => {
          if (!signal.aborted) queue.push({ type: "error", message: error instanceof BridgeError ? error.message : "Browser runtime failed; acceptance may be unknown. Do not automatically retry.", status: 502, errorType: "server_error", code: "bridge_error", retryable: false });
        }).finally(() => { signal.removeEventListener("abort", close); queue.close(); });
        return new Response(bridgeToResponsesSSE(queue, model, undefined, undefined, undefined, () => { abort.abort(); queue.close(); }, options.heartbeatMs ?? 2000, { stallTimeoutSec: options.stallTimeoutSec }), {
          headers: { ...headers, "Content-Type": "text/event-stream" },
        });
      }
      return json(buildResponseJSON(await run(), model));
    } catch (error) {
      const status = request.signal.aborted ? 499 : error instanceof BridgeError ? error.status : 502;
      return json({ error: { message: error instanceof BridgeError ? error.message : "Browser runtime failed; acceptance may be unknown. Do not automatically retry.", type: status >= 500 ? "server_error" : "invalid_request_error", code: status === 401 ? "invalid_api_key" : "bridge_error" } }, status);
    }
  };
}
