"""Declarative provider for the Hermes-owned Responses bridge."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from providers.base import ProviderProfile

CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/"
# Catalog probe budget. Context resolution runs on agent start and on the compressor's first
# access, so the answer is memoized; a dead bridge must not stall either path.
_CONTEXT_CATALOG_TTL_SECONDS = 300.0
_CONTEXT_CATALOG_TIMEOUT_SECONDS = 2.0

_context_catalog_cache: dict[str, Any] = {"at": 0.0, "models": {}}


class ChatGPTWebProfile(ProviderProfile):
    def __init__(self) -> None:
        super().__init__(
            name="chatgpt-web",
            display_name="ChatGPT Web",
            description="Your signed-in browser, with tools executed by Hermes",
            api_mode="codex_responses",
            auth_type="api_key",
            env_vars=("CHATGPT_WEB_API_KEY",),
            base_url="http://127.0.0.1:8766/v1",
            supports_vision=True,
            supports_streaming=True,
            fallback_models=(
                "chatgpt-web/gpt-6-sol-instant",
                "chatgpt-web/gpt-6-sol",
                "chatgpt-web/gpt-5.6-sol-instant",
                "chatgpt-web/gpt-5.6-sol",
            ),
            ambient_credentials=True,
        )

    def fetch_models(self, **kwargs: Any) -> list[str] | None:
        models = super().fetch_models(**kwargs)
        if models is None:
            return None
        return [model for model in models if model.startswith(CHATGPT_WEB_MODEL_PREFIX)]

    def get_model_context_length(self, model: str) -> int | None:
        """Context window the browser route can actually carry.

        The upstream ChatGPT model advertises a window far larger than the measured browser
        transport, and Hermes compacts the transcript as a percentage of whatever it is told.
        Reporting the upstream figure lets a session grow until the browser rejects the prompt
        outright, so the bridge publishes its own measured budget and the host reads it from
        there. Falls back to the normal resolution path when the bridge is unreachable.
        """
        entry = self._context_catalog().get(model)
        context_window = entry.get("context_window") if isinstance(entry, dict) else None
        return context_window if isinstance(context_window, int) and context_window > 0 else None

    def _context_catalog(self) -> dict[str, dict[str, Any]]:
        now = time.monotonic()
        if now - _context_catalog_cache["at"] < _CONTEXT_CATALOG_TTL_SECONDS and _context_catalog_cache["models"]:
            return _context_catalog_cache["models"]
        base_url = (self.base_url or "").rstrip("/")
        api_key = os.environ.get("CHATGPT_WEB_API_KEY", "")
        if not base_url or not api_key:
            return _context_catalog_cache["models"]
        request = urllib.request.Request(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=_CONTEXT_CATALOG_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, TimeoutError):
            return _context_catalog_cache["models"]
        models = {
            entry["id"]: entry
            for entry in payload.get("data", [])
            if isinstance(entry, dict) and isinstance(entry.get("id"), str)
        }
        _context_catalog_cache.update({"at": now, "models": models})
        return models
