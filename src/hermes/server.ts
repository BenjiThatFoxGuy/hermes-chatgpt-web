import { existsSync } from "node:fs";
import { loadConfig, providerConfig, expandUserPath } from "../config";
import { createHermesBrowserAdapter } from "./browser";
import { createHermesHandler, DEFAULT_MAX_BODY_BYTES, type HermesHandlerOptions } from "./handler";

export interface HermesServerOptions extends HermesHandlerOptions { port?: number }

/** The listener address is deliberately not configurable or exposed through a tunnel. */
export function startHermesServer(options: HermesServerOptions) {
  const port = options.port ?? 8766;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Bridge port must be an integer between 0 and 65535");
  const handler = createHermesHandler(options);
  return Bun.serve({
    hostname: "127.0.0.1", port, development: false, reusePort: false, idleTimeout: 0,
    // The handler enforces the smaller streamed JSON bound. This is a second transport ceiling.
    maxRequestBodySize: Math.max(64 * 1024 * 1024, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
    fetch: handler,
    error() {
      return Response.json({ error: { type: "server_error", code: "bridge_transport_error", message: "Bridge transport failed. Do not automatically retry." } }, {
        status: 500, headers: { "x-should-retry": "false", "Cache-Control": "no-store" },
      });
    },
  });
}

export function configuredHermesServerOptions(): HermesServerOptions {
  const apiKey = process.env.CHATGPT_WEB_API_KEY;
  if (!apiKey?.trim()) throw new Error("CHATGPT_WEB_API_KEY is required; use a new local bridge bearer, not ChatGPT credentials");
  if (process.env.CHATGPT_WEB_HOST && process.env.CHATGPT_WEB_HOST !== "127.0.0.1") throw new Error("The Hermes bridge may bind only 127.0.0.1");
  const configuredPort = process.env.CHATGPT_WEB_PORT ?? "8766";
  if (!/^[1-9]\d*$/.test(configuredPort) || Number(configuredPort) > 65535) throw new Error("CHATGPT_WEB_PORT must be an integer between 1 and 65535");
  let config;
  try { config = loadConfig(); }
  catch { throw new Error("Configured browser runtime is missing or invalid. Configure the upstream Launcher runtime first; this bridge never runs setup or modifies Codex configuration."); }
  if (config.browserInteractionMode === "manual") throw new Error("Hermes requires the configured browser runtime to use automatic mode; the manual Codex MCP harness is not used");
  if (config.browserHost === "launcher") {
    if (!config.browserHostDescriptorPath || !existsSync(expandUserPath(config.browserHostDescriptorPath))) {
      throw new Error("Configured browser runtime is unavailable: start its existing Launcher browser host before the bridge");
    }
  } else if (!existsSync(expandUserPath(config.storageStatePath)) || !existsSync(expandUserPath(config.chromeExecutablePath))) {
    throw new Error("Configured browser runtime is unavailable: browser storage state or Chrome executable is missing");
  }
  const provider = providerConfig(config);
  const modelAllowlist = process.env.CHATGPT_WEB_MODELS === undefined ? undefined : process.env.CHATGPT_WEB_MODELS.split(",");
  return {
    apiKey, port: Number(configuredPort), capabilities: config, modelAllowlist,
    adapter: createHermesBrowserAdapter(provider), stallTimeoutSec: config.stallTimeoutSec,
  };
}

if (import.meta.main) {
  try {
    const server = startHermesServer(configuredHermesServerOptions());
    console.log(`Hermes ChatGPT Web bridge listening on http://127.0.0.1:${server.port}/v1 (buffered envelope Responses)`);
    const stop = () => { void server.stop(true); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to start the Hermes browser bridge");
    process.exitCode = 1;
  }
}
