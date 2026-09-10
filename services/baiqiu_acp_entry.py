from acp_adapter import entry

import asyncio
import logging
import json
import os
import re
import time
import uuid
from urllib.parse import urlparse


def canonical_provider(config, requested=None, base_url=None):
    model_config = config.get("model") or {}
    if not isinstance(model_config, dict):
        model_config = {}
    selected = str(requested or model_config.get("provider") or "").strip()
    if selected != "custom":
        return selected
    endpoint = str(base_url or model_config.get("base_url") or "").rstrip("/")
    matches = [
        str(provider.get("name") or "").strip()
        for provider in config.get("custom_providers", [])
        if isinstance(provider, dict)
        and str(provider.get("base_url") or "").rstrip("/") == endpoint
        and provider.get("name")
    ]
    if len(matches) != 1:
        raise ValueError("Cannot restore custom provider: endpoint identity is missing or ambiguous")
    return "custom:" + matches[0]


def install_remote_probe_guard():
    from agent import image_routing, model_metadata
    original = image_routing._should_probe_ollama_vision
    if getattr(original, "_baiqiu_remote_guard", False):
        return

    def should_probe(provider, base_url):
        if str(provider or "").lower() != "ollama" and not model_metadata.is_local_endpoint(base_url):
            return False
        return original(provider, base_url)

    should_probe._baiqiu_remote_guard = True
    image_routing._should_probe_ollama_vision = should_probe


def session_manager_class(base_class, load_config):
    class BaiqiuSessionManager(base_class):
        def _make_agent(self, **kwargs):
            config = load_config()
            selected = canonical_provider(config, kwargs.get("requested_provider"), kwargs.get("base_url"))
            if selected:
                kwargs["requested_provider"] = selected
            model_config = config.get("model") or {}
            if selected == canonical_provider(config):
                if not kwargs.get("base_url") and model_config.get("base_url"):
                    kwargs["base_url"] = model_config["base_url"]
                if not kwargs.get("api_mode") and model_config.get("api_mode"):
                    kwargs["api_mode"] = model_config["api_mode"]
            agent = super()._make_agent(**kwargs)
            agent._baiqiu_requested_provider = selected
            bind_provider_protocol(agent, config.get("baiqiu", {}).get("provider_protocol"))
            return agent

        def _persist(self, state):
            super()._persist(state)
            selected = getattr(state.agent, "_baiqiu_requested_provider", "")
            if not selected.startswith("custom:"):
                return
            database = self._get_db()
            row = database.get_session(state.session_id) if database else None
            if row is None:
                return
            metadata = json.loads(row.get("model_config") or "{}")
            metadata["provider"] = selected
            metadata["base_url"] = state.agent.base_url
            metadata["api_mode"] = state.agent.api_mode
            database.update_session_meta(state.session_id, json.dumps(metadata), state.model)

    return BaiqiuSessionManager


def prepare_skill_index(state):
    agent = state.agent
    if state.is_running or not any(name in agent.valid_tool_names for name in ("skills_list", "skill_view", "skill_manage")):
        return
    from gateway.session_context import set_session_vars, clear_session_vars
    from agent.coding_context import coding_compact_skill_categories
    from run_agent import build_skills_system_prompt, get_toolset_for_tool

    tokens = set_session_vars(session_key=state.session_id, session_id=state.session_id,
                              cwd=state.cwd, cron_session="")
    try:
        toolsets = {toolset for name in agent.valid_tool_names if (toolset := get_toolset_for_tool(name))}
        compact = coding_compact_skill_categories(platform=agent.platform, cwd=state.cwd)
        build_skills_system_prompt(available_tools=agent.valid_tool_names,
                                  available_toolsets=toolsets, compact_categories=compact or None)
    finally:
        clear_session_vars(tokens)


def bind_provider_protocol(agent, protocol=None):
    if not isinstance(protocol, dict) or protocol.get("id") != "glm-preserved-thinking":
        return
    build = getattr(agent, "_build_api_kwargs", None)
    needs_pad = getattr(agent, "_needs_thinking_reasoning_pad", None)
    if not callable(build) or not callable(needs_pad):
        return

    def applies():
        endpoint = str(getattr(agent, "base_url", "") or "").rstrip("/")
        return (getattr(agent, "api_mode", "") == "chat_completions"
                and getattr(agent, "provider", "") == protocol.get("provider") == "zai"
                and str(getattr(agent, "model", "")).lower() == protocol.get("model")
                and endpoint == protocol.get("baseURL")
                and urlparse(endpoint).hostname == "open.bigmodel.cn")

    def reasoning_pad():
        return True if applies() else needs_pad()

    def build_request(*args, **kwargs):
        request = build(*args, **kwargs)
        if not applies():
            return request
        request = {**request, "extra_body": {**(request.get("extra_body") or {}), **protocol["extraBody"]}}
        if protocol.get("reasoningEffort"):
            request["extra_body"]["reasoning_effort"] = protocol["reasoningEffort"]
            request.pop("reasoning_effort", None)
        return request

    agent._needs_thinking_reasoning_pad = reasoning_pad
    agent._build_api_kwargs = build_request


def discard_interrupted_runtime_prompt(state, prompt):
    if not prompt:
        return False
    incoming = "\n".join(block.text for block in prompt if getattr(block, "type", None) == "text").strip()
    marker = "\n[User request]\n"
    with state.runtime_lock:
        interrupted = state.interrupted_prompt_text or ""
        if state.is_running or not all(text.startswith("[Runtime context]\n") and marker in text for text in (incoming, interrupted)):
            return False
        if incoming.split(marker, 1)[1].strip():
            state.interrupted_prompt_text = ""
            return True
    return False


def runtime_prompt_parts(text):
    marker = "\n[User request]\n"
    if not isinstance(text, str) or not text.startswith("[Runtime context]\n") or marker not in text:
        return None
    current = text.rsplit("\n\nUser correction/guidance after interrupt: [Runtime context]\n", 1)[-1]
    if current != text:
        current = "[Runtime context]\n" + current
    context, request = current.split(marker, 1)
    return context, request


def without_visible_history(context):
    return re.sub(r"\n\n\[Recent visible conversation\]\n[\s\S]*?(?=\n\n\[|\Z)", "", context, count=1)


def runtime_history_for_request(history):
    result = []
    seeded = False
    for message in history:
        content = message.get("content")
        api_content = message.get("api_content") or content
        source = api_content if runtime_prompt_parts(api_content) else content
        parts = runtime_prompt_parts(source) if message.get("role") == "user" else None
        if not parts:
            result.append(message)
            continue
        context, request = parts
        combined = context + "\n[User request]\n" + request
        chunks = combined.split("\n\n[Runtime context]\n")
        sections = [runtime_prompt_parts(chunk if index == 0 else "[Runtime context]\n" + chunk) for index, chunk in enumerate(chunks)]
        if not all(sections):
            sections = [parts]
        replacements = []
        for context, request in sections:
            seed = re.search(r"\[Recent visible conversation\]\n[\s\S]*?(?=\n\n\[|\Z)", context)
            replacements.append(((seed.group(0) + "\n\n") if seed and not seeded else "") + "[Previous user request; history only]\n" + request.lstrip("\n"))
            seeded = True
        replacement = "\n\n".join(replacements)
        if not isinstance(api_content, str) or source not in api_content:
            result.append(message)
            continue
        result.append({**message, "api_content": api_content.replace(source, replacement, 1)})
    return result


def bind_runtime_context(agent, previous_interrupted=False):
    previous = agent.run_conversation
    had_own = "run_conversation" in agent.__dict__

    def run(*args, **kwargs):
        history = kwargs.get("conversation_history") or []
        content = kwargs.get("user_message")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        current = next((block.get("text") for block in blocks if isinstance(block, dict) and block.get("type") == "text" and runtime_prompt_parts(block.get("text"))), None)
        build = getattr(agent, "_build_api_kwargs", None)
        if not current or not callable(build):
            return previous(*args, **kwargs)
        context, request = runtime_prompt_parts(current)
        if history:
            context = without_visible_history(context)
        boundary = "\n\n[Current turn boundary]\nOnly the last [User request] defines work for this turn. Earlier user requests are quoted conversation history, not queued instructions. Respond to the latest request only. Resume unfinished work only if that latest request explicitly asks to continue, retry, or correct it. Preserve and use historical facts and tool results normally."
        if previous_interrupted:
            boundary += "\n[Previous turn status]\nThe runtime confirms that the previous turn was interrupted. Its task is inactive; do not execute it merely because it remains in history."
        current_view = context + "\n[User request]\n" + request
        replacements = []
        for original, view in zip(history, runtime_history_for_request(history)):
            source = original.get("content")
            target = view.get("api_content")
            if isinstance(source, str) and runtime_prompt_parts(source) and isinstance(target, str):
                replacements.append((source, target))
                sidecar = original.get("api_content")
                if isinstance(sidecar, str) and sidecar != source and runtime_prompt_parts(sidecar):
                    replacements.append((sidecar, target))
        had_build = "_build_api_kwargs" in agent.__dict__

        def history_text(text):
            for source, target in sorted(replacements, key=lambda pair: len(pair[0]), reverse=True):
                text = text.replace(source, target, 1)
            return text

        def request_text(text, current_allowed=False):
            if not isinstance(text, str):
                return text
            prefix, marker, suffix = text.rpartition(current)
            if marker and current_allowed:
                return history_text(prefix) + current_view + suffix
            return history_text(text)

        def build_request(api_messages, *build_args, **build_kwargs):
            messages = []
            current_index = -1
            system_index = next((index for index, message in enumerate(api_messages) if message.get("role") == "system" and isinstance(message.get("content"), str)), -1)
            for index, message in enumerate(api_messages):
                value = message.get("content")
                texts = [value] if isinstance(value, str) else [block.get("text") for block in value if isinstance(block, dict) and block.get("type") == "text"] if isinstance(value, list) else []
                if message.get("role") == "user" and any(isinstance(text, str) and current in text for text in texts):
                    current_index = index
            for index, message in enumerate(api_messages):
                value = message.get("content")
                if message.get("role") == "system" and isinstance(value, str):
                    original = "Only serialize calls when a later call genuinely depends on an earlier call's result (e.g. you must read a file before you can patch it). When in doubt and the calls are independent, batch them."
                    replacement = "Serialize calls when a later call depends on an earlier result, or when the user requests sequential execution or a stage reply before the next action. Independent calls may be batched only when this preserves the requested execution and delivery order."
                    message = {**message, "content": value.replace(original, replacement) + (boundary if index == system_index else "")}
                if message.get("role") == "user":
                    if isinstance(value, str):
                        message = {**message, "content": request_text(value, index == current_index)}
                    elif isinstance(value, list):
                        message = {**message, "content": [{**block, "text": request_text(block.get("text"), index == current_index)} if isinstance(block, dict) and block.get("type") == "text" else block for block in value]}
                messages.append(message)
            return build(messages, *build_args, **build_kwargs)

        agent._build_api_kwargs = build_request
        try:
            return previous(*args, **kwargs)
        finally:
            if agent._build_api_kwargs is build_request:
                if had_build:
                    agent._build_api_kwargs = build
                else:
                    del agent._build_api_kwargs

    agent.run_conversation = run

    def restore():
        if agent.run_conversation is run:
            if had_own:
                agent.run_conversation = previous
            else:
                del agent.run_conversation
    return restore


def provider_error_diagnostic(error_message, error_type="", status_code=None, diag=None):
    text = str(error_message or "").lower()
    if "overloaded" in text or "overcapacity" in text or "server_overloaded" in text:
        code = "HERMES_PROVIDER_OVERLOADED"
    elif status_code == 429 or "rate_limit" in text or "rate limit" in text:
        code = "HERMES_PROVIDER_RATE_LIMITED"
    elif status_code in (401, 403):
        code = "HERMES_PROVIDER_AUTH_FAILED"
    elif "timeout" in text or "timed out" in text:
        code = "HERMES_PROVIDER_READ_TIMEOUT"
    elif any(word in text for word in ("connection", "network", "broken pipe", "peer closed")):
        code = "HERMES_PROVIDER_STREAM_DROPPED"
    else:
        code = "HERMES_PROVIDER_FAILURE"
    result = {
        "type": "provider_error", "code": code,
        "errorType": re.sub(r"[^a-zA-Z0-9_]", "", str(error_type))[:80],
        "timestamp": time.time_ns() // 1_000_000,
    }
    if "weekly_limit_exceeded" in text or "weekly usage limit exceeded" in text:
        result["errorCategory"] = "weekly_limit_exceeded"
    if isinstance(status_code, int):
        result["httpStatus"] = status_code
    for source, target in (("started_at", "requestStartedAt"), ("first_chunk_at", "firstChunkAt")):
        value = (diag or {}).get(source)
        if isinstance(value, (int, float)) and value > 0:
            result[target] = round(value * 1000)
    return result


def bind_provider_diagnostics(agent, conn, session_id, loop):
    import acp
    from acp_adapter.events import _send_update

    bindings = []

    def bind(name):
        previous = getattr(agent, name, None)
        if not callable(previous):
            return
        had_own = name in agent.__dict__

        def observed(*args, **kwargs):
            error = args[0] if args else kwargs.get("error")
            diagnostic = provider_error_diagnostic(
                kwargs.get("error_message") or str(error or ""),
                kwargs.get("error_type") or (type(error).__name__ if error else ""),
                kwargs.get("status_code") or getattr(error, "status_code", None),
                kwargs.get("diag") or {"started_at": kwargs.get("api_start_time")},
            )
            update = acp.update_agent_message_text("")
            update.field_meta = {"baiqiu_diagnostic": diagnostic}
            try:
                _send_update(conn, session_id, loop, update)
            except Exception:
                logging.getLogger(__name__).debug("Provider diagnostic delivery failed", exc_info=True)
            return previous(*args, **kwargs)

        setattr(agent, name, observed)
        bindings.append((name, previous, observed, had_own))

    for name in ("_is_provider_stream_parse_error", "_invoke_api_request_error_hook", "_emit_stream_drop", "_log_stream_retry"):
        bind(name)

    def restore():
        for name, previous, observed, had_own in bindings:
            if getattr(agent, name, None) is observed:
                if had_own:
                    setattr(agent, name, previous)
                else:
                    delattr(agent, name)

    return restore


def make_tool_generation_callback(conn, session_id, loop):
    import acp
    from acp_adapter.events import _send_update

    def tool_generating(tool_name):
        name = str(tool_name or "").strip()
        if not name:
            return
        update = acp.update_agent_message_text("")
        update.field_meta = {
            "baiqiu_execution": {
                "type": "tool_generating",
                "eventId": f"tool-generation:{uuid.uuid4()}",
                "timestamp": time.time_ns() // 1_000_000,
                "toolName": name,
                "message": f"正在生成 {name} 调用参数",
            }
        }
        _send_update(conn, session_id, loop, update)

    return tool_generating


def bind_provider_timings(agent, conn, session_id, loop):
    import acp
    import httpx
    from acp_adapter.events import _send_update

    name = "_create_request_openai_client"
    previous = getattr(agent, name, None)
    if not callable(previous):
        return lambda: None
    had_own = name in agent.__dict__
    hooks = []

    def publish(stage, request_id, **details):
        update = acp.update_agent_message_text("")
        update.field_meta = {"baiqiu_diagnostic": {
            "type": "provider_timing", "stage": stage, "requestId": request_id,
            "timestamp": time.time_ns() // 1_000_000, **details,
        }}
        try:
            _send_update(conn, session_id, loop, update)
        except Exception:
            logging.getLogger(__name__).debug("Provider timing delivery failed", exc_info=True)

    class ObservedStream(httpx.SyncByteStream):
        def __init__(self, stream, request_id):
            self.stream = stream
            self.request_id = request_id
            self.bytes_received = 0
            self.last_activity_at = 0

        def __iter__(self):
            for chunk in self.stream:
                if chunk and not self.bytes_received:
                    publish("first_byte", self.request_id)
                self.bytes_received += len(chunk)
                observed_at = time.monotonic()
                if chunk and observed_at - self.last_activity_at >= 1:
                    publish("stream_activity", self.request_id, bytesReceived=self.bytes_received)
                    self.last_activity_at = observed_at
                yield chunk

        def close(self):
            try:
                self.stream.close()
            finally:
                publish("stream_closed", self.request_id, bytesReceived=self.bytes_received)

    def request_started(request):
        request_id = str(uuid.uuid4())
        request.extensions["baiqiu_request_id"] = request_id
        details = {}
        try:
            body = json.loads(request.content)
            details = {
                "toolCount": len(body.get("tools") or []),
                "reasoningEffort": body.get("reasoning_effort"),
                "thinkingEnabled": (body.get("thinking") or {}).get("type") == "enabled",
                "preservedThinking": (body.get("thinking") or {}).get("clear_thinking") is False,
                "toolStream": body.get("tool_stream") is True,
                "replayedReasoningChars": sum(len(message.get("reasoning_content") or "") for message in body.get("messages", [])),
            }
        except (TypeError, ValueError, AttributeError):
            pass
        publish("http_request", request_id, requestBytes=len(request.content), **details)
        previous_trace = request.extensions.get("trace")

        def trace(event, info):
            if event in (
                "connection.connect_tcp.started", "connection.connect_tcp.complete",
                "connection.start_tls.started", "connection.start_tls.complete",
                "http11.send_request_body.complete", "http2.send_request_body.complete",
                "http11.receive_response_headers.started", "http2.receive_response_headers.started",
            ):
                publish(event.replace(".", "_"), request_id)
            if previous_trace:
                previous_trace(event, info)

        request.extensions["trace"] = trace

    def response_received(response):
        request_id = response.request.extensions.get("baiqiu_request_id", "")
        publish("http_headers", request_id, httpStatus=response.status_code)
        if isinstance(response.stream, httpx.SyncByteStream):
            response.stream = ObservedStream(response.stream, request_id)

    def observed(*args, **kwargs):
        request_id = str(uuid.uuid4())
        api_kwargs = kwargs.get("api_kwargs") or {}
        try:
            context_chars = len(json.dumps(api_kwargs.get("messages") or [], ensure_ascii=False))
        except (TypeError, ValueError):
            context_chars = 0
        publish("client_prepare", request_id,
                messageCount=len(api_kwargs.get("messages") or []),
                toolCount=len(api_kwargs.get("tools") or []),
                contextChars=context_chars,
                runtimeContextCount=sum(json.dumps(message.get("content") or "", ensure_ascii=False).count("[Runtime context]") for message in api_kwargs.get("messages", []) if message.get("role") == "user"),
                visibleHistoryCount=sum(json.dumps(message.get("content") or "", ensure_ascii=False).count("[Recent visible conversation]") for message in api_kwargs.get("messages", []) if message.get("role") == "user"))
        client = previous(*args, **kwargs)
        transport = getattr(client, "_client", None)
        if isinstance(transport, httpx.Client) and not any(item[0] is transport for item in hooks):
            transport.event_hooks["request"].append(request_started)
            transport.event_hooks["response"].append(response_received)
            hooks.append((transport, request_started, response_received))
        publish("client_ready", request_id)
        return client

    setattr(agent, name, observed)

    def restore():
        if getattr(agent, name, None) is observed:
            if had_own:
                setattr(agent, name, previous)
            else:
                delattr(agent, name)
        for transport, request_hook, response_hook in hooks:
            for kind, hook in (("request", request_hook), ("response", response_hook)):
                if hook in transport.event_hooks[kind]:
                    transport.event_hooks[kind].remove(hook)

    return restore


def install_tool_completion_compat():
    from acp_adapter import events
    original = events.build_tool_complete
    if getattr(original, "_baiqiu_arguments_compat", False):
        return

    def build_tool_complete(*args, **kwargs):
        arguments = kwargs.get("function_args")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except (ValueError, TypeError):
                arguments = {"raw": arguments}
            kwargs["function_args"] = arguments if isinstance(arguments, dict) else {"raw": arguments}
        return original(*args, **kwargs)

    build_tool_complete._baiqiu_arguments_compat = True
    events.build_tool_complete = build_tool_complete


def main():
    args = entry._parse_args()
    if args.version or args.check or args.setup or args.setup_browser:
        return entry.main()
    entry._setup_logging()
    entry._load_env()

    import acp
    from acp_adapter.server import HermesACPAgent
    from acp_adapter.session import SessionManager
    from hermes_cli.config import load_config

    install_remote_probe_guard()
    install_tool_completion_compat()
    manager = session_manager_class(SessionManager, load_config)()

    logger = logging.getLogger(__name__)

    class BaiqiuACPAgent(HermesACPAgent):
        async def _register_session_mcp_servers(self, state, mcp_servers):
            await super()._register_session_mcp_servers(state, mcp_servers)
            try:
                await asyncio.to_thread(prepare_skill_index, state)
            except Exception:
                logger.warning("Session skill index preparation failed", exc_info=True)

        async def resume_session(self, cwd, session_id, **kwargs):
            if self.session_manager.get_session(session_id) is None:
                raise ValueError("BAIQIU_SESSION_RESTORE_FAILED: original session could not be restored")
            response = await super().resume_session(cwd=cwd, session_id=session_id, **kwargs)
            response.field_meta = {**(response.field_meta or {}), "baiqiuSessionId": session_id}
            return response

        async def prompt(self, prompt, session_id, **kwargs):
            state = self.session_manager.get_session(session_id)
            if state is None or state.is_running or not self._conn:
                return await super().prompt(prompt, session_id, **kwargs)
            previous_interrupted = discard_interrupted_runtime_prompt(state, prompt)
            agent = state.agent
            if not hasattr(agent, "tool_gen_callback"):
                logger.warning("Native runtime has no tool generation callback")
                return await super().prompt(prompt, session_id, **kwargs)
            previous = agent.tool_gen_callback
            publish = make_tool_generation_callback(
                self._conn, session_id, asyncio.get_running_loop()
            )

            def tool_generating(tool_name):
                try:
                    publish(tool_name)
                finally:
                    if previous:
                        previous(tool_name)

            agent.tool_gen_callback = tool_generating
            restore_diagnostics = bind_provider_diagnostics(agent, self._conn, session_id, asyncio.get_running_loop())
            restore_timings = bind_provider_timings(agent, self._conn, session_id, asyncio.get_running_loop())
            restore_context = bind_runtime_context(agent, previous_interrupted)
            from baiqiu_async_delivery import bind_async_delivery
            finish_delivery = bind_async_delivery(state)
            delivery_succeeded = False
            try:
                response = await super().prompt(prompt, session_id, **kwargs)
                delivery_succeeded = response.stop_reason == "end_turn"
                return response
            finally:
                finish_delivery(delivery_succeeded)
                restore_context()
                restore_timings()
                restore_diagnostics()
                if agent.tool_gen_callback is tool_generating:
                    agent.tool_gen_callback = previous

    if os.environ.get("HERMES_ACP_SKIP_CONFIGURED_MCP", "").strip() != "1":
        try:
            from hermes_cli.mcp_startup import start_background_mcp_discovery

            start_background_mcp_discovery(
                logger=logger, thread_name="acp-mcp-discovery"
            )
        except Exception:
            logger.debug("MCP tool discovery failed at ACP startup", exc_info=True)
    try:
        asyncio.run(acp.run_agent(BaiqiuACPAgent(session_manager=manager), use_unstable_protocol=True))
    except KeyboardInterrupt:
        logger.info("Shutting down (KeyboardInterrupt)")
    except Exception:
        logger.exception("ACP agent crashed")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
