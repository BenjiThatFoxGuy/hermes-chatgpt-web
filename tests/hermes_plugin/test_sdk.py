"""Real SDK over loopback; only the browser's external I/O is a fixture."""

from pathlib import Path
import selectors
import subprocess

from openai import AuthenticationError, OpenAI
import pytest

ROOT = Path(__file__).resolve().parents[2]
MODEL = "chatgpt-web/gpt-6-sol"
TOOL = {
    "type": "function", "name": "hermes_test_add", "description": "Add two integers",
    "parameters": {"type": "object", "properties": {
        "a": {"type": "integer"}, "b": {"type": "integer"}},
        "required": ["a", "b"], "additionalProperties": False},
}


@pytest.fixture(scope="module")
def endpoint():
    process = subprocess.Popen(
        ["bun", "run", "tests/hermes_plugin/serve_fixture.ts"], cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            assert selector.select(timeout=30), "browser fixture HTTP server did not start"
        url = process.stdout.readline().strip()
        assert url.startswith("http://127.0.0.1:"), url
        yield url
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def test_real_sdk_tool_request_host_execution_and_result_replay(endpoint):
    import json

    with OpenAI(base_url=endpoint, api_key="sdk-contract-fixture-key", max_retries=0) as client:
        first = client.responses.create(
            model=MODEL, input="Run the harmless host test tool", tools=[TOOL], store=False,
        )
        assert first.status == "completed"
        call = first.output[0]
        assert call.type == "function_call" and call.name == "hermes_test_add"
        args = json.loads(call.arguments)
        # The browser never executes this. The actual host executes this harmless tool.
        actual_result = args["a"] + args["b"]
        assert actual_result == 5
        second = client.responses.create(model=MODEL, tools=[TOOL], store=False, input=[
            {"role": "user", "content": "Run the harmless host test tool"},
            call.model_dump(exclude_none=True),
            {"type": "function_call_output", "call_id": call.call_id, "output": str(actual_result)},
        ])
        assert second.output_text == "Actual host result: 5"
        assert second.usage.input_tokens == 12
        assert second.usage.output_tokens == 8


def test_real_sdk_raw_stream_events(endpoint):
    with OpenAI(base_url=endpoint, api_key="sdk-contract-fixture-key", max_retries=0) as client:
        with client.responses.create(model=MODEL, input="stream-message", stream=True) as stream:
            events = list(stream)
        assert any(event.type == "response.output_text.delta" for event in events)
        completed = [event for event in events if event.type == "response.completed"]
        assert len(completed) == 1
        assert completed[0].response.output[0].content[0].text == "SDK stream received"


def test_real_sdk_wrong_key_rejected_without_browser_execution(endpoint):
    with OpenAI(base_url=endpoint, api_key="wrong-fixture-key", max_retries=0) as client:
        with pytest.raises(AuthenticationError):
            client.responses.create(model=MODEL, input="Do not execute")


def test_real_sdk_only_browser_models_are_listed(endpoint):
    with OpenAI(base_url=endpoint, api_key="sdk-contract-fixture-key", max_retries=0) as client:
        models = list(client.models.list())
        assert models
        assert all(model.id.startswith("chatgpt-web/") for model in models)
