"""Declarative provider for the Hermes-owned Responses bridge."""

from typing import Any

from providers.base import ProviderProfile


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
            fallback_models=(),
            ambient_credentials=True,
        )

    def fetch_models(self, **kwargs: Any) -> list[str] | None:
        models = super().fetch_models(**kwargs)
        if models is None:
            return None
        return [model for model in models if model.startswith("chatgpt-web/")]
