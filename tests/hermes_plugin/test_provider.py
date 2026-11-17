"""Tests run against the real pinned Hermes provider registry in CI."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def load_plugin():
    path = ROOT / "__init__.py"
    assert path.exists(), "chatgpt-web model-provider entry point is missing"
    spec = importlib.util.spec_from_file_location(
        "_chatgpt_web_contract", path, submodule_search_locations=[str(ROOT)]
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from providers import get_provider_profile
    return get_provider_profile("chatgpt-web")


def test_provider_registers_real_responses_profile():
    profile = load_plugin()
    assert profile is not None
    assert profile.name == "chatgpt-web"
    assert profile.api_mode == "codex_responses"
    assert profile.auth_type == "api_key"
    assert profile.env_vars == ("CHATGPT_WEB_API_KEY",)
    assert profile.base_url == "http://127.0.0.1:8766/v1"
    assert profile.supports_vision
    assert profile.fallback_models == ()  # Account availability is not guessed.
    assert profile.create_client() is None  # Real SDK, not a second agent loop.


def test_live_catalog_filters_native_routes(monkeypatch):
    profile = load_plugin()
    from providers.base import ProviderProfile
    monkeypatch.setattr(ProviderProfile, "fetch_models", lambda *a, **k: [
        "gpt-6", "chatgpt-web/sol", "chatgpt-web/pro", "other/chatgpt-web/pro"
    ])
    assert profile.fetch_models(api_key="fixture") == ["chatgpt-web/sol", "chatgpt-web/pro"]


def test_unavailable_catalog_does_not_invent_account_models(monkeypatch):
    profile = load_plugin()
    from providers.base import ProviderProfile
    monkeypatch.setattr(ProviderProfile, "fetch_models", lambda *a, **k: None)
    assert profile.fetch_models(api_key="fixture") is None


def test_native_plugin_admission_validation():
    from hermes_cli.plugin_validate import validate_plugin_dir

    report = validate_plugin_dir(ROOT)
    assert report.ok, report.to_dict()


def test_installer_flat_layout_is_discovered(tmp_path):
    assert (ROOT / "plugin.yaml").exists(), "model-provider manifest is missing"
    installed = tmp_path / "plugins" / "chatgpt-web"
    installed.mkdir(parents=True)
    for name in ("plugin.yaml", "__init__.py", "provider.py"):
        shutil.copy2(ROOT / name, installed / name)
    env = dict(os.environ, HERMES_HOME=str(tmp_path), CHATGPT_WEB_API_KEY="fixture-only")
    result = subprocess.run([sys.executable, "-c", '''
import json
from providers import get_provider_profile
from hermes_cli.providers import determine_api_mode
from hermes_cli.runtime_provider import resolve_runtime_provider
p = get_provider_profile("chatgpt-web")
assert p is not None
assert determine_api_mode(p.name, p.base_url) == "codex_responses"
runtime = resolve_runtime_provider(requested="chatgpt-web", target_model="chatgpt-web/gpt-6-sol")
assert runtime["provider"] == "chatgpt-web"
assert runtime["api_mode"] == "codex_responses"
assert runtime["base_url"] == p.base_url
print(json.dumps({"name": p.name, "api_mode": p.api_mode}))
'''], env=env, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.splitlines()[-1])["name"] == "chatgpt-web"
