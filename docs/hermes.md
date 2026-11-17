# Hermes integration

This private derivative preserves the history and browser engine of
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web).
The Hermes provider slug is **`chatgpt-web`**. Upstream Codex installation and
packaging are retained separately; they are not the Hermes setup procedure.

## Architecture

```text
Hermes agent + approvals + canonical history
  -> OpenAI SDK Responses requests on authenticated loopback
  -> Hermes host adapter
  -> upstream browser-only engine
  -> your signed-in ChatGPT browser
```

Hermes owns tool execution. The browser receives tool definitions as part of a
structured response contract and returns either a message or proposed tool calls.
The host validates tool names and arguments, converts proposals into Responses
`function_call` items, and returns them to Hermes. Only Hermes executes those
calls. Their real `function_call_output` records are sent back in the next request.
This is a structured-envelope adaptation, not a claim that ChatGPT Web exposes a
native OpenAI tools API.

Upstream Full harness mode and its Codex MCP execution broker are **not** used by
this provider. No Codex rollout, sandbox record or task identity is synthesized.
Each request carries the complete Hermes history. Browser authentication and
model selection remain upstream responsibilities.

## Runtime boundaries

- Minimum supported Hermes baseline: 0.23.2.
- Transport: `codex_responses`, not Chat Completions.
- Default bridge URL: `http://127.0.0.1:8766/v1`.
- `CHATGPT_WEB_API_KEY` is a new local bridge bearer, not an OpenAI API key or a
  ChatGPT login cookie. Both Hermes and the bridge need the same value.
- Keep the bridge key in a private environment file outside Git. Hermes credentials
  belong in the active profile's `.env`; non-secret settings belong in config.
- The bridge must not listen on a public interface. Do not expose it through a
  reverse proxy or tunnel.
- The model catalog comes from configured browser/account capabilities. No static
  fallback models assert that your account has access to a particular model.
- Model-generated envelope bytes must be validated before becoming tool calls.
  An SSE response may therefore be buffered until its envelope is complete. Do not
  interpret heartbeat events as token-by-token delivery.

## Development and verification

All builds and tests run on self-hosted GitHub Actions. The inherited hosted
packaging/release jobs are gated to the original upstream repository, preventing private-fork
pushes and tags from consuming hosted runner minutes or publishing upstream
releases. CI produces two SHA-256-checked archives:

- `chatgpt-web-plugin.tar.gz`: the small, installable provider directory, validated
  by Hermes's real admission checks.
- `hermes-chatgpt-web-source.tar.gz`: the complete separate browser-runtime source.

The whole upstream-derived repository is **not** the admission-clean plugin
artifact. Its retained translated READMEs, installer examples and diagnostic
fixtures trigger Hermes's scanner. Do not bypass that scanner to install the full
engine as a profile plugin; use the validated provider artifact and run the
browser engine as a separate explicitly configured local service.

Offline tests replace browser I/O with explicit fixtures. They do not prove login,
DOM selectors, account entitlements or a live ChatGPT tool round-trip. Those require
an approved browser runtime and an authenticated account. Do not use real login
state or bridge keys in CI.

## Running the separate browser bridge

The production entry point is:

```sh
bun run src/hermes/server.ts
```

Run it from the browser-runtime source with its locked Bun dependencies installed
and an already configured, signed-in upstream browser runtime. Its process
must receive `CHATGPT_WEB_API_KEY` securely from the same private credential
source used by Hermes. The bridge does not run upstream setup, create a Codex
integration or manage a service unit. For Launcher-backed configurations, the
existing Launcher browser host must already be running.

Optional runtime environment settings:

- `CHATGPT_WEB_PORT`: loopback port, default `8766`.
- `CHATGPT_WEB_MODELS`: comma-separated exact model slugs to restrict the
  account-capability catalog. Unknown or unavailable slugs fail startup.
- `CODEX_CHATGPT_WEB_HOME`: upstream runtime configuration location.

The listener address is fixed to `127.0.0.1`. Each browser request uses a fresh
conversation and does not select a native connector. The HTTP request-body limit
is 8 MiB; the validated browser reply limit is 2 MiB. Inline PNG/JPEG/GIF/WebP
images are supported. Stored response continuation IDs, hosted/native tools,
sampling parameters and hard output-token controls are not supported.

SSE retains real progress heartbeats while buffering the structured reply.
Only validated message text or tool calls leave that buffer. Cancellation aborts
the browser turn; unknown browser acceptance is not automatically retried.

## Live setup status

Development is intentionally separate from installation. No live Hermes profile,
model selection, service unit, browser login, or gateway restart is changed by
creating this repository. Installation and browser/account smoke testing require
separate approval after the CI artifact is ready.

Before switching providers, inspect existing `model.base_url` and `model.api_mode`:
those settings can override the provider defaults. Configuration changes should
use `hermes config set` / `hermes config unset`, not manual YAML editing.

## Known inherited baseline issue

The first unchanged upstream CI run failed dependency auditing with seven findings
in its pinned Hono dependencies (six moderate, one low). This predates the Hermes
adapter and must not be described as a new plugin regression or a clean security
audit. Do not deploy the inherited network stack without reviewing these findings.
