"""Import-time registration required by Hermes model-provider discovery."""

from providers import register_provider

from .provider import ChatGPTWebProfile

register_provider(ChatGPTWebProfile())
