"""ChatGPT Web plugin: provider registration + managed bridge lifecycle.

Import-time: registers the ChatGPTWebProfile so the provider is available
to the model picker and ``/model`` as soon as plugins load.

register(ctx): spawns the bridge subprocess, registers setup CLI, and
hooks on_unload to tear it down when the gateway stops.
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Provider registration (import-time, before register(ctx) runs)
# ---------------------------------------------------------------------------
from providers import register_provider  # noqa: E402
from .provider import ChatGPTWebProfile  # noqa: E402

_profile = ChatGPTWebProfile()
register_provider(_profile)

# ---------------------------------------------------------------------------
# Bridge process state (module-level so on_unload can reach it)
# ---------------------------------------------------------------------------
_bridge_proc: subprocess.Popen | None = None

_PLUGIN_DIR = Path(__file__).resolve().parent
_DEFAULT_BUN_PATHS = (
    Path.home() / ".bun" / "bin" / "bun",
    Path("/usr/local/bin/bun"),
    Path("/usr/bin/bun"),
)


def _find_bun(configured: str = "") -> str | None:
    """Resolve the bun binary: explicit config > well-known paths > PATH."""
    if configured:
        p = Path(configured).expanduser()
        return str(p) if p.is_file() and os.access(p, os.X_OK) else None
    for candidate in _DEFAULT_BUN_PATHS:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which("bun")


def _bridge_server_ts() -> Path:
    return _PLUGIN_DIR / "src" / "hermes" / "server.ts"


def _start_bridge(bun: str, port: int, models: str = "") -> subprocess.Popen | None:
    """Start the bridge as a child process. Returns the Popen or None on failure."""
    server_ts = _bridge_server_ts()
    if not server_ts.exists():
        logger.error("chatgpt-web: bridge entry point not found at %s", server_ts)
        return None

    env = {**os.environ, "CHATGPT_WEB_PORT": str(port)}
    if models:
        env["CHATGPT_WEB_MODELS"] = models

    try:
        proc = subprocess.Popen(
            [bun, "run", str(server_ts)],
            cwd=str(_PLUGIN_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        # Give it a moment to bind or die
        time.sleep(1.5)
        if proc.poll() is not None:
            stderr = ((proc.stderr.read() if proc.stderr else b"") or b"").decode(errors="replace").strip()
            logger.error(
                "chatgpt-web: bridge exited immediately (rc=%s): %s",
                proc.returncode, stderr[:500],
            )
            return None
        logger.info("chatgpt-web: bridge started on 127.0.0.1:%d (pid %d)", port, proc.pid)
        return proc
    except Exception as exc:
        logger.error("chatgpt-web: failed to start bridge: %s", exc)
        return None


def _stop_bridge() -> None:
    """Gracefully stop the bridge subprocess."""
    global _bridge_proc
    proc = _bridge_proc
    _bridge_proc = None
    if proc is None or proc.poll() is not None:
        return
    logger.info("chatgpt-web: stopping bridge (pid %d)", proc.pid)
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        logger.warning("chatgpt-web: bridge did not exit after SIGTERM, killing")
        proc.kill()
        proc.wait(timeout=5)
    except Exception as exc:
        logger.warning("chatgpt-web: error stopping bridge: %s", exc)


def _is_bridge_alive(port: int) -> bool:
    """Quick health check: does the bridge respond to /v1/models?"""
    import urllib.request
    api_key = os.environ.get("CHATGPT_WEB_API_KEY", "")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/models",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# register(ctx) - called by PluginManager for kind: standalone
# ---------------------------------------------------------------------------
def register(ctx) -> None:
    global _bridge_proc

    port = ctx.get_config("bridge_port", 8766)
    bun_path = ctx.get_config("bun_path", "")
    models = ctx.get_config("models", "")

    # Update the provider's base_url to match the configured port
    _profile.base_url = f"http://127.0.0.1:{port}/v1"

    # Find bun
    bun = _find_bun(bun_path)
    if not bun:
        logger.warning(
            "chatgpt-web: bun not found. The bridge won't start automatically. "
            "Set plugins.entries.chatgpt-web.settings.bun_path or install bun."
        )
    else:
        # Check if something is already listening (e.g. the old systemd service)
        if _is_bridge_alive(port):
            logger.info(
                "chatgpt-web: bridge already running on port %d, not starting a second one",
                port,
            )
        else:
            _bridge_proc = _start_bridge(bun, port, models)

    # Register cleanup
    ctx.on_unload(_stop_bridge)

    # Register the setup CLI command
    from .setup_services import register_cli, chatgpt_web_setup_command
    ctx.register_cli_command(
        name="chatgpt-web",
        help="Set up and manage the ChatGPT Web browser bridge",
        setup_fn=register_cli,
        handler_fn=chatgpt_web_setup_command,
        description=(
            "Install browser runtime dependencies, configure the display and "
            "launcher services, generate bridge credentials, and check health."
        ),
    )
