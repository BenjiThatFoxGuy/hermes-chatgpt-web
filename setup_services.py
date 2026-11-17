"""CLI subcommand: ``hermes chatgpt-web`` - setup, health, and service management.

Subcommands:
  setup   - install dependencies, write systemd units, generate bridge key
  health  - check that all three layers (display, launcher, bridge) are alive
  status  - show service states and bridge catalog
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent

# Systemd unit templates live in services/
_SERVICES_DIR = _PLUGIN_DIR / "services"

_DISPLAY_SERVICE = "chatgpt-web-display"
_LAUNCHER_SERVICE = "chatgpt-web-launcher"
_BRIDGE_SERVICE = "chatgpt-web-bridge"

_SYSTEMD_USER_DIR = Path.home() / ".config" / "systemd" / "user"


def _run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def _systemctl(*args: str) -> subprocess.CompletedProcess:
    return _run(["systemctl", "--user", *args])


# ---------------------------------------------------------------------------
# Setup subcommand
# ---------------------------------------------------------------------------

def _check_xvfb() -> bool:
    return shutil.which("Xvfb") is not None


def _find_launcher() -> str | None:
    """Find the launcher AppImage or binary."""
    candidates = [
        Path.home() / ".local" / "bin" / "codex-web-gpt",
        Path.home() / ".local" / "bin" / "chatgpt-web-gpt",
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return shutil.which("codex-web-gpt") or shutil.which("chatgpt-web-gpt")


def _generate_bridge_key() -> str:
    """Generate a secure random bearer token for bridge auth."""
    return f"cgw-{secrets.token_urlsafe(32)}"


def _write_service_unit(name: str, content: str) -> Path:
    """Write a systemd user unit file."""
    _SYSTEMD_USER_DIR.mkdir(parents=True, exist_ok=True)
    path = _SYSTEMD_USER_DIR / f"{name}.service"
    path.write_text(content)
    return path


def _display_unit() -> str:
    return textwrap.dedent("""\
        [Unit]
        Description=Virtual display for ChatGPT Web launcher

        [Service]
        Type=simple
        ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
        Restart=on-failure
        RestartSec=3

        [Install]
        WantedBy=default.target
    """)


def _launcher_unit(launcher_path: str) -> str:
    return textwrap.dedent(f"""\
        [Unit]
        Description=ChatGPT Web authenticated launcher host
        After={_DISPLAY_SERVICE}.service network-online.target
        Requires={_DISPLAY_SERVICE}.service
        Wants=network-online.target

        [Service]
        Type=simple
        Environment=DISPLAY=:99
        Environment=APPIMAGE_EXTRACT_AND_RUN=1
        ExecStart={launcher_path} --no-sandbox --disable-gpu
        Restart=on-failure
        RestartSec=5
        TimeoutStopSec=30

        [Install]
        WantedBy=default.target
    """)


def _do_setup(args: Any) -> str:
    """Run the full setup sequence."""
    lines: list[str] = []

    # 1. Check Xvfb
    if _check_xvfb():
        lines.append("✓ Xvfb is installed")
    else:
        lines.append("✗ Xvfb not found. Install it: sudo apt install xvfb")
        return "\n".join(lines)

    # 2. Find launcher
    launcher = getattr(args, "launcher_path", None) or _find_launcher()
    if launcher:
        lines.append(f"✓ Launcher found: {launcher}")
    else:
        lines.append(
            "✗ Launcher binary not found. Place it at ~/.local/bin/codex-web-gpt "
            "or pass --launcher-path"
        )
        return "\n".join(lines)

    # 3. Check config
    config_path = Path.home() / ".codex-chatgpt-web" / "config.json"
    if config_path.exists():
        lines.append(f"✓ Config exists: {config_path}")
    else:
        lines.append(
            f"✗ No config at {config_path}. Run the launcher once manually to "
            "authenticate and create the browser session."
        )
        return "\n".join(lines)

    # 4. Write display service
    _write_service_unit(_DISPLAY_SERVICE, _display_unit())
    lines.append(f"✓ Wrote {_DISPLAY_SERVICE}.service")

    # 5. Write launcher service
    _write_service_unit(_LAUNCHER_SERVICE, _launcher_unit(launcher))
    lines.append(f"✓ Wrote {_LAUNCHER_SERVICE}.service")

    # 6. Generate bridge key if not set
    env_path = None
    try:
        from hermes_constants import get_hermes_home
        env_path = get_hermes_home() / ".env"
    except Exception:
        env_path = Path.home() / ".hermes" / ".env"

    existing_key = os.environ.get("CHATGPT_WEB_API_KEY", "")
    if existing_key:
        lines.append("✓ CHATGPT_WEB_API_KEY already set in environment")
    else:
        key = _generate_bridge_key()
        # Append to .env
        with open(env_path, "a") as f:
            f.write(f'\nCHATGPT_WEB_API_KEY="{key}"\n')
        lines.append(f"✓ Generated bridge key and appended to {env_path}")

    # 7. Reload and enable
    _systemctl("daemon-reload")
    _systemctl("enable", "--now", f"{_DISPLAY_SERVICE}.service")
    _systemctl("enable", "--now", f"{_LAUNCHER_SERVICE}.service")
    lines.append(f"✓ Enabled and started {_DISPLAY_SERVICE} + {_LAUNCHER_SERVICE}")

    lines.append("")
    lines.append(
        "Setup complete. The bridge starts automatically with the Hermes gateway. "
        "Run `hermes chatgpt-web health` to verify."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Health subcommand
# ---------------------------------------------------------------------------

def _do_health(args: Any) -> str:
    lines: list[str] = []

    # Display service
    r = _systemctl("is-active", f"{_DISPLAY_SERVICE}.service")
    active = r.stdout.strip() == "active"
    lines.append(f"{'✓' if active else '✗'} {_DISPLAY_SERVICE}: {r.stdout.strip()}")

    # Launcher service
    r = _systemctl("is-active", f"{_LAUNCHER_SERVICE}.service")
    active = r.stdout.strip() == "active"
    lines.append(f"{'✓' if active else '✗'} {_LAUNCHER_SERVICE}: {r.stdout.strip()}")

    # Bridge (may be managed by plugin or systemd)
    import urllib.request
    api_key = os.environ.get("CHATGPT_WEB_API_KEY", "")
    port = 8766  # TODO: read from plugin config
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/models",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode())
            model_count = len(data.get("data", []))
            models = ", ".join(m["id"] for m in data.get("data", []))
            lines.append(f"✓ bridge: listening on :{port} ({model_count} models: {models})")
    except Exception as exc:
        lines.append(f"✗ bridge: not responding on :{port} ({exc})")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Status subcommand
# ---------------------------------------------------------------------------

def _do_status(args: Any) -> str:
    lines: list[str] = []
    for svc in (_DISPLAY_SERVICE, _LAUNCHER_SERVICE):
        r = _systemctl("status", "--no-pager", "-l", f"{svc}.service")
        lines.append(f"--- {svc} ---")
        lines.append(r.stdout.strip() if r.stdout.strip() else r.stderr.strip())
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI registration
# ---------------------------------------------------------------------------

def register_cli(parser: Any) -> None:
    """Add subcommands to the ``hermes chatgpt-web`` parser."""
    subs = parser.add_subparsers(dest="chatgpt_web_action")

    setup_p = subs.add_parser("setup", help="Install deps, write service units, generate bridge key")
    setup_p.add_argument("--launcher-path", help="Explicit path to the launcher binary")

    subs.add_parser("health", help="Check display, launcher, and bridge health")
    subs.add_parser("status", help="Show systemd service status")


def chatgpt_web_setup_command(raw_args: str = "", **kwargs: Any) -> str:
    """Entry point for ``hermes chatgpt-web <action>``."""
    import argparse
    parser = argparse.ArgumentParser(prog="hermes chatgpt-web")
    register_cli(parser)

    try:
        args = parser.parse_args(raw_args.split() if raw_args else [])
    except SystemExit:
        return parser.format_help()

    action = getattr(args, "chatgpt_web_action", None)
    if action == "setup":
        return _do_setup(args)
    elif action == "health":
        return _do_health(args)
    elif action == "status":
        return _do_status(args)
    else:
        return parser.format_help()
