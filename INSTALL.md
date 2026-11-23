# Installing the ChatGPT Web provider for Hermes

This guide walks you through setting up the `chatgpt-web` provider, which lets
[Hermes](https://hermes-agent.nousresearch.com) use your signed-in ChatGPT
browser session as a model backend. Tools execute locally in Hermes - the browser
only handles inference.

> **For AI agents:** this document is the canonical setup reference. Follow it
> step-by-step; do not skip prerequisites or invent shortcuts. When something
> fails, check the Troubleshooting section at the bottom before retrying.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Linux with systemd** (user units) | The display, launcher and bridge run as `--user` services |
| **Xvfb** | Provides a virtual display for the headless Electron launcher |
| **bun >= 1.1** | Runs the TypeScript bridge server |
| **Hermes >= 0.23.2** | Provider plugin API compatibility |
| **A ChatGPT Plus or Pro account** | The browser session needs an active subscription |
| **Google Chrome or Chromium** | The launcher's Electron shell uses it for the browser session |

---

## 1. Install system dependencies

```bash
# Xvfb (virtual framebuffer)
sudo apt install -y xvfb

# bun (JavaScript/TypeScript runtime)
# IMPORTANT: install into ~/.bun, NOT /tmp (gets wiped on reboot)
curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash

# Confirm bun is on PATH
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Add `export PATH="$HOME/.bun/bin:$PATH"` to your shell profile (`~/.bashrc`,
`~/.zshrc`, etc.) so it persists.

---

## 2. Clone the repository

```bash
git clone https://github.com/BenjiThatFoxGuy/hermes-chatgpt-web.git ~/projects/hermes-chatgpt-web
cd ~/projects/hermes-chatgpt-web
bun install --frozen-lockfile
```

---

## 3. Install the launcher

The launcher is an Electron app that holds the authenticated ChatGPT session.
Download the AppImage for your architecture from the
[upstream releases](https://github.com/miuuyy/codex-chatgpt-web/releases/latest):

```bash
# Example for x64:
mkdir -p ~/.local/bin
curl -fsSL -o ~/.local/bin/codex-web-gpt \
  "https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/codex-web-gpt-$(curl -sI https://github.com/miuuyy/codex-chatgpt-web/releases/latest | grep -i '^location:' | sed 's|.*/v||;s/\r//')-linux-x64.AppImage"
chmod +x ~/.local/bin/codex-web-gpt
```

> **arm64:** replace `x64` with `arm64` in the filename.

---

## 4. Authenticate the browser session

Run the launcher once interactively to sign into ChatGPT:

```bash
# If you have a display:
~/.local/bin/codex-web-gpt

# If headless - start Xvfb first, then use a VNC or noVNC viewer to interact:
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
DISPLAY=:99 ~/.local/bin/codex-web-gpt --no-sandbox --disable-gpu
```

Sign in with your ChatGPT credentials in the browser window that opens.
Once signed in, close the launcher. This creates the config at
`~/.codex-chatgpt-web/config.json` and stores browser session state.

> **Important:** the launcher stores the authenticated session persistently.
> You only need to sign in once. The session survives restarts unless ChatGPT
> itself expires it.

---

## 5. Generate and configure the bridge API key

The bridge uses a local bearer token (not your ChatGPT credentials) to
authenticate requests from Hermes. Generate one and add it to Hermes' env file:

```bash
# Generate a secure random key
BRIDGE_KEY="cgw-$(openssl rand -base64 32 | tr -d '/+=' | head -c 43)"

# Add to Hermes .env
echo "CHATGPT_WEB_API_KEY=\"$BRIDGE_KEY\"" >> ~/.hermes/.env

# Verify it's set
grep CHATGPT_WEB_API_KEY ~/.hermes/.env
```

> **Security:** this key never leaves your machine. It authenticates the
> loopback connection between Hermes and the bridge on 127.0.0.1. It is NOT
> your ChatGPT password or API token.

---

## 6. Create systemd user services

### Option A: automatic (recommended)

If the Hermes plugin is already installed (step 7), run:

```bash
hermes chatgpt-web setup
```

This writes all three unit files, generates a bridge key if missing, and enables
the services.

### Option B: manual

Create three unit files in `~/.config/systemd/user/`:

**chatgpt-web-display.service** - virtual display

```ini
[Unit]
Description=Virtual display for ChatGPT Web launcher

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

**chatgpt-web-launcher.service** - authenticated browser host

```ini
[Unit]
Description=ChatGPT Web authenticated launcher host
After=chatgpt-web-display.service network-online.target
Requires=chatgpt-web-display.service
Wants=network-online.target

[Service]
Type=simple
Environment=DISPLAY=:99
Environment=APPIMAGE_EXTRACT_AND_RUN=1
ExecStart=%h/.local/bin/codex-web-gpt --no-sandbox --disable-gpu
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

**chatgpt-web-bridge.service** - Hermes loopback bridge

```ini
[Unit]
Description=Hermes ChatGPT Web loopback bridge
After=network-online.target chatgpt-web-launcher.service
Wants=network-online.target chatgpt-web-launcher.service
ConditionPathExists=%h/.codex-chatgpt-web/config.json

[Service]
Type=simple
WorkingDirectory=%h/projects/hermes-chatgpt-web
EnvironmentFile=%h/.hermes/.env
Environment=CHATGPT_WEB_PORT=8766
ExecStart=%h/.bun/bin/bun run src/hermes/server.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.codex-chatgpt-web

[Install]
WantedBy=default.target
```

Then enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-web-display chatgpt-web-launcher chatgpt-web-bridge
```

---

## 7. Install the Hermes provider plugin

The plugin tells Hermes how to talk to the bridge. Snapshot the provider files
into a versioned plugin source, then install:

```bash
# Create the plugin source directory
mkdir -p ~/.hermes/plugin-sources/chatgpt-web
cd ~/.hermes/plugin-sources/chatgpt-web
git init -q

# Copy provider files from the fork
cp ~/projects/hermes-chatgpt-web/{provider.py,__init__.py,plugin.yaml,LICENSE,setup_services.py} .
git add -A && git commit -qm "chatgpt-web provider"

# Install and enable the plugin
hermes plugins install file://$HOME/.hermes/plugin-sources/chatgpt-web
hermes plugins enable chatgpt-web
```

---

## 8. Configure Hermes to use the provider

```bash
# Set as default provider (optional - you can also use it via fallback)
hermes config set model.provider chatgpt-web
hermes config set model.default chatgpt-web/gpt-6-sol

# Or add it to your fallback chain
hermes fallback add chatgpt-web/gpt-6-sol --provider chatgpt-web
```

Available models depend on your ChatGPT subscription:

- `chatgpt-web/gpt-6-sol` - GPT-6 Sol (Plus/Pro)
- `chatgpt-web/gpt-5.6-sol` - GPT-5.6 Sol (Plus/Pro)

---

## 9. Verify

```bash
# Check all three services are running
systemctl --user is-active chatgpt-web-display chatgpt-web-launcher chatgpt-web-bridge

# Check the bridge health endpoint
source ~/.hermes/.env
curl -s -H "Authorization: Bearer $CHATGPT_WEB_API_KEY" http://127.0.0.1:8766/health

# Check Hermes sees the provider
hermes fallback check

# Send a live test message
hermes chat -q 'Reply with exactly: WEB_OK' \
  --provider chatgpt-web -m chatgpt-web/gpt-6-sol \
  --reasoning none --max-turns 1 -Q
```

Expected output from health: `{"status":"ok","count":2,"models":[...],...}`
Expected output from test: `WEB_OK`

---

## Updating

When the fork gets new commits:

```bash
cd ~/projects/hermes-chatgpt-web && git pull --ff-only
~/.bun/bin/bun install --frozen-lockfile

# Re-snapshot the plugin
S=~/.hermes/plugin-sources/chatgpt-web
cp ~/projects/hermes-chatgpt-web/{provider.py,__init__.py,plugin.yaml,LICENSE,setup_services.py} $S/
cd $S && git add -A && git commit -qm "provider snapshot $(git -C ~/projects/hermes-chatgpt-web rev-parse --short HEAD)"
hermes plugins install file://$S && hermes plugins enable chatgpt-web

# Restart the bridge (runs from the fork checkout)
systemctl --user restart chatgpt-web-bridge
```

---

## Troubleshooting

### Bridge won't start

```bash
# Check the bridge logs
journalctl --user -u chatgpt-web-bridge --no-pager -n 30

# Common causes:
# - CHATGPT_WEB_API_KEY not set in ~/.hermes/.env
# - ~/.codex-chatgpt-web/config.json doesn't exist (run the launcher first)
# - bun not found (check ~/.bun/bin/bun exists and PATH is set in the unit)
```

### "Model not found" or fallback skips chatgpt-web

```bash
# Check the bridge is responding
source ~/.hermes/.env
curl -s -H "Authorization: Bearer $CHATGPT_WEB_API_KEY" http://127.0.0.1:8766/v1/models

# Make sure --provider chatgpt-web is passed alongside -m
# -m alone does NOT switch provider
hermes chat -q 'test' --provider chatgpt-web -m chatgpt-web/gpt-6-sol
```

### Session expired

If ChatGPT signs you out, the bridge returns 502 errors. Re-authenticate:

```bash
systemctl --user stop chatgpt-web-launcher
# Start launcher interactively, sign in again, then:
systemctl --user start chatgpt-web-launcher
```

### Literal `\n` in responses instead of newlines

Update to the latest fork (the fix is in `src/hermes/envelope.ts`):

```bash
cd ~/projects/hermes-chatgpt-web && git pull --ff-only
systemctl --user restart chatgpt-web-bridge
```

### bun disappeared after reboot

bun was probably installed into `/tmp`. Reinstall into `~/.bun`:

```bash
curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash
```

---

## Architecture

```
Hermes  --(HTTP, Bearer auth)-->  Bridge (bun, 127.0.0.1:8766)
                                    |
                                    v
                                  Launcher (Electron, Xvfb :99)
                                    |
                                    v
                                  ChatGPT (authenticated browser session)
```

- **Hermes** sends Responses-API or Chat Completions requests to the bridge
- The **bridge** wraps the request in a JSON envelope, sends it through the
  launcher's browser worker, and streams the response back
- The **launcher** holds the authenticated ChatGPT session in a headless
  Electron window and exposes a local browser worker API
- **Tools execute in Hermes**, never in the browser - the bridge translates
  tool calls into Hermes envelope format

The bridge binds only to `127.0.0.1` and cannot be exposed to the network.
All auth is local bearer-token only.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHATGPT_WEB_API_KEY` | **Yes** | - | Local bridge bearer token (not ChatGPT credentials) |
| `CHATGPT_WEB_PORT` | No | `8766` | Port the bridge binds to on 127.0.0.1 |
| `CHATGPT_WEB_HOST` | No | `127.0.0.1` | Must be `127.0.0.1` (enforced) |
| `CHATGPT_WEB_MODELS` | No | all available | Comma-separated model allowlist |

---

## License

This fork is based on [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web).
See [LICENSE](LICENSE) for terms.
