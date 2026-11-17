# Hermes Web GPT provider - setup and operations

The fork ships a Hermes **provider** (`chatgpt-web`), not a set of aliased model ids. Hermes
discovers it as a plugin, lists its models live from the local bridge, and resolves each route's
context window from the same catalog.

## Layout

- Fork checkout: `~/projects/hermes-chatgpt-web`
- Launcher (signed-in ChatGPT browser): `codex-web-gpt`, run by `chatgpt-web-launcher.service`
- Bridge (loopback OpenAI-compatible gateway): `chatgpt-web-bridge.service`, `127.0.0.1:8766`
- Display: `chatgpt-web-display.service` (Xvfb `:99`)
- Plugin source (durable, versioned): `~/.hermes/plugin-sources/chatgpt-web` - a git repo holding
  exactly `provider.py`, `__init__.py`, `plugin.yaml`, `LICENSE`
- Installed plugin: `~/.hermes/plugins/chatgpt-web`

## First-time setup

```bash
# 1. three user services (Xvfb, launcher, bridge)
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-web-display chatgpt-web-launcher chatgpt-web-bridge

# 2. sign in to ChatGPT once inside the launcher window

# 3. install the provider plugin from the versioned source dir
mkdir -p ~/.hermes/plugin-sources/chatgpt-web
cd ~/.hermes/plugin-sources/chatgpt-web && git init -q
cp ~/projects/hermes-chatgpt-web/{provider.py,__init__.py,plugin.yaml,LICENSE} .
git add -A && git commit -qm "chatgpt-web provider"
hermes plugins install file://$HOME/.hermes/plugin-sources/chatgpt-web
hermes plugins enable chatgpt-web      # gateway reloads plugins and keeps running

# 4. point Hermes at the provider (no alias needed)
hermes config set model.provider chatgpt-web
hermes config set model.default chatgpt-web/gpt-6-sol
```

Plugin and config both live under `~/.hermes` (shared instance state), so every Hermes profile on
this machine sees them; only one profile exists here.

## Using it

- Switch models with `/model chatgpt-web/gpt-6-sol`, `/model chatgpt-web/gpt-5.6-sol`, or
  `/model chatgpt-web/gpt-6-pro` / `gpt-5.6-pro`.
- Nothing needs a manual model refresh: the bridge publishes `/v1/models` and Hermes re-reads it.
  `hermes model --refresh` only clears the picker disk cache if a list ever looks stale.
- Tools execute in Hermes, never in the browser.

## Context windows

The browser transport is smaller than the upstream model advertises, so each route publishes its
own measured budget (Plus account, no Bigger Context):

- `gpt-6-sol`, `gpt-5.6-sol`: context 90,000, auto-compact 80,000 (89%)
- legacy `light` / `medium` / `high` / `extra-high` / `pro`: 41,000-90,000 by effort
- `gpt-5.6-luna`: reported at the upstream window; experimental

The Instant routes (`*-sol-instant`) were removed: their 41k ceiling sits below the minimum window
Hermes needs for multi-step tool use, so they could not work through the host. Hermes reads
`context_window`, `max_context_window`, `auto_compact_token_limit` and
`effective_context_window_percent` straight from the bridge catalog, and the provider profile
resolves the same numbers as a fallback when the bridge is unreachable.

## Updating after a fork commit

```bash
cd ~/projects/hermes-chatgpt-web && git pull --ff-only
S=~/.hermes/plugin-sources/chatgpt-web
cp ~/projects/hermes-chatgpt-web/{provider.py,__init__.py,plugin.yaml,LICENSE} $S/
cd $S && git add -A && git commit -qm "provider snapshot $(git -C ~/projects/hermes-chatgpt-web rev-parse --short HEAD)"
hermes plugins install file://$S && hermes plugins enable chatgpt-web
systemctl --user restart chatgpt-web-bridge   # bridge runs from the fork checkout
```

## Verify

```bash
systemctl --user is-active chatgpt-web-display chatgpt-web-launcher chatgpt-web-bridge
curl -s -H "Authorization: Bearer $CHATGPT_WEB_API_KEY" http://127.0.0.1:8766/v1/models
hermes chat -q 'Reply with exactly: WEB_OK' -m chatgpt-web/gpt-6-sol --reasoning none --max-turns 1 -Q
```

Expected catalog ids: `chatgpt-web/gpt-6-sol`, `chatgpt-web/gpt-5.6-sol`,
`chatgpt-web/gpt-5.6-pro`, `chatgpt-web/gpt-6-pro`.

## Notes

- The launcher UI (window title, menus) still carries the upstream product name until a launcher
  release is built and installed; the fork source is already de-branded.
- Session loss only happens if ChatGPT itself expires the login; the launcher profile persists.
