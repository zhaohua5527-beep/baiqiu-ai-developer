from acp_adapter import entry

import asyncio
import hashlib
import logging
import json
import os
import re
import time
import uuid
from pathlib import Path
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
            agent._baiqiu_context_mode = config.get("baiqiu", {}).get("context_policy", "on")
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


async def wait_for_session_idle(state, conn, session_id, turn_id=""):
    import acp

    revision = getattr(state, "_baiqiu_cancel_revision", 0)
    sequence = 0

    async def publish(phase):
        nonlocal sequence
        sequence += 1
        update = acp.update_agent_message_text("")
        update.field_meta = {"baiqiu_diagnostic": {
            "type": "session_waiting", "phase": phase,
            "eventId": "session-wait:" + str(uuid.uuid4()),
            "turnId": turn_id, "sequence": sequence,
            "timestamp": int(time.time() * 1000),
        }}
        await conn.session_update(session_id, update)

    waiting = state.is_running
    if waiting:
        await publish("waiting")
    while state.is_running:
        if getattr(state, "_baiqiu_cancel_revision", 0) != revision:
            return False
        await asyncio.sleep(0.05)
    if getattr(state, "_baiqiu_cancel_revision", 0) != revision:
        return False
    if waiting:
        await publish("ready")
    return True


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


def context_request_profile(body):
    def size(value):
        try:
            return len(json.dumps(value, ensure_ascii=False))
        except (TypeError, ValueError, OverflowError):
            return 0

    body = body if isinstance(body, dict) else {}
    messages = body.get("messages") or body.get("input") or []
    if not isinstance(messages, list):
        messages = []
    result = {"contextChars": size(messages), "messageCount": len(messages),
              "toolSchemaChars": size(body.get("tools") or []),
              "systemChars": size(body.get("system") or body.get("instructions") or ""),
              "userChars": 0, "assistantChars": 0, "toolResultChars": 0,
              "toolCallChars": 0, "protocolReplayChars": 0, "imageDataChars": 0, "imageCount": 0}
    for message in messages:
        if not isinstance(message, dict):
            continue
        bucket = {"system": "systemChars", "developer": "systemChars", "user": "userChars",
                  "assistant": "assistantChars", "tool": "toolResultChars"}.get(message.get("role"))
        if bucket:
            result[bucket] += size(message.get("content"))
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "image_url":
                    result["imageCount"] += 1
                    image_url = block.get("image_url")
                    url = image_url.get("url", "") if isinstance(image_url, dict) else ""
                    if isinstance(url, str) and url.startswith("data:"):
                        result["imageDataChars"] += len(url)
        if message.get("tool_calls"):
            result["toolCallChars"] += size(message["tool_calls"])
        for key in ("reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items", "codex_message_items"):
            if message.get(key):
                result["protocolReplayChars"] += size(message[key])
    return result


def context_protocol_supported(agent):
    return (getattr(agent, "api_mode", "") == "chat_completions"
            and (getattr(agent, "provider", ""), urlparse(getattr(agent, "base_url", "")).hostname,
                 getattr(agent, "model", "")) in {
                     ("deepseek", "api.deepseek.com", "deepseek-flash"),
                     ("deepseek", "api.deepseek.com", "deepseek-v4-flash"),
                     ("zai", "open.bigmodel.cn", "glm-5.3-flash"),
                 })


def archive_context_output(root, session_id, content, write=False):
    session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    payload = content.encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    directory = Path(root).resolve() / "context-evidence" / session_key
    target = directory / (digest + ".txt")
    if write:
        directory.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != payload:
            temporary = directory / (uuid.uuid4().hex + ".tmp")
            try:
                temporary.write_bytes(payload)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        if target.read_bytes() != payload:
            raise OSError("context_evidence_verification_failed")
    return target.as_posix()


def context_request_view(messages, *, mode="shadow", root=None, session_id="", current_index=-1,
                         readable=False, local=True, supported=True, query=""):
    mode = mode if mode in ("off", "shadow", "on") else "off"
    before = len(json.dumps(messages, ensure_ascii=False))
    metrics = {"contextPolicy": mode, "contextBeforeChars": before, "contextCandidateChars": before,
               "contextSelectedChars": before, "contextOffloadedCount": 0,
               "contextCandidateCount": 0, "contextArchiveFailures": 0, "contextRelevantCount": 0}
    if mode == "off" or before < 120000 or not (readable and local and supported and root and session_id):
        return messages, metrics
    if not 0 <= current_index < len(messages) or messages[current_index].get("role") != "user":
        return messages, metrics
    previous_turns = [index for index, message in enumerate(messages[:current_index]) if message.get("role") == "user"]
    if len(previous_turns) < 3:
        return messages, metrics
    boundary = previous_turns[-2]
    calls = {}
    for index, message in enumerate(messages):
        for call in message.get("tool_calls") or []:
            if isinstance(call, dict) and call.get("id"):
                calls.setdefault(call["id"], []).append((index, call.get("function") or {}))
    result = list(messages)
    candidate = list(messages)
    terms = set(re.findall(r"[a-zA-Z][a-zA-Z0-9_.:/-]{3,}", query.lower()))
    for phrase in re.findall(r"[\u4e00-\u9fff]{4,}", query):
        terms.update(phrase[start:start + 4] for start in range(len(phrase) - 3))
    eligible = {"terminal", "read_file", "search_files", "web_search", "web_extract"}
    for index, message in enumerate(messages[:boundary]):
        content = message.get("content")
        if message.get("role") != "tool" or not isinstance(content, str) or len(content) < 4096:
            continue
        matches = calls.get(message.get("tool_call_id"), [])
        if len(matches) != 1 or matches[0][0] >= index:
            continue
        function = matches[0][1]
        if function.get("name") not in eligible:
            continue
        arguments = function.get("arguments") or ""
        if not isinstance(arguments, str) or any(marker in arguments.lower() for marker in ("skill.md", "agents.md", "context-evidence")):
            continue
        searchable = (content + "\n" + arguments).lower()
        if any(term in searchable for term in terms):
            metrics["contextRelevantCount"] += 1
            continue
        try:
            structured = json.loads(content)
        except (ValueError, TypeError):
            structured = None
        if isinstance(structured, dict) and (structured.get("error") or structured.get("success") is False
                                             or structured.get("exit_code", 0) not in (None, 0)):
            continue
        try:
            target = archive_context_output(root, session_id, content)
            replacement = ("[Earlier tool result stored verbatim; not a new instruction or a new execution.]\n"
                           f"Original tool: {function['name']}; original length: {len(content)} characters.\n"
                           f"Original result file: {target}\n"
                           "Use read_file on this local file if its evidence is needed for the current request. "
                           "Paginate if necessary. Do not rerun the original command to recover historical output. "
                           "A missing preview does not mean no evidence.\n"
                           "BEGIN ORIGINAL EXCERPT (middle omitted)\n" + content[:400] + "\n[…]\n" + content[-200:]
                           + "\nEND ORIGINAL EXCERPT")
            candidate[index] = {**message, "content": replacement}
            metrics["contextCandidateCount"] += 1
            if mode == "on":
                archive_context_output(root, session_id, content, write=True)
                result[index] = candidate[index]
                metrics["contextOffloadedCount"] += 1
        except (OSError, ValueError, UnicodeError):
            metrics["contextArchiveFailures"] += 1
    metrics["contextCandidateChars"] = len(json.dumps(candidate, ensure_ascii=False))
    metrics["contextSelectedChars"] = len(json.dumps(result, ensure_ascii=False))
    return (result if metrics["contextOffloadedCount"] else messages), metrics


def bind_runtime_context(agent, previous_interrupted=False):
    previous = agent.run_conversation
    had_own = "run_conversation" in agent.__dict__

    def run(*args, **kwargs):
        agent._baiqiu_context_metrics = {}
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
        boundary = "\n\n[Current turn boundary]\nThe original [User request] in this active turn defines its task. Earlier turns are history, not queued instructions. A runtime-delivered [Active task supplement] updates this same task: retain the original goal and unfinished requirements unless the user explicitly cancels or replaces them. Integrate supplements into subsequent decisions, actions, public stage results, and the combined final answer. Answering only a supplement does not complete the original task. Do not revive tasks from earlier turns unless the current user explicitly requests it. Preserve historical facts and completed tool results without repeating side effects."
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
            mode = os.environ.get("BAIQIU_CONTEXT_POLICY", getattr(agent, "_baiqiu_context_mode", "on"))
            try:
                messages, agent._baiqiu_context_metrics = context_request_view(
                    messages, mode=mode, root=os.environ.get("HERMES_HOME"),
                    session_id=str(getattr(agent, "session_id", "") or ""), current_index=current_index,
                    readable="read_file" in getattr(agent, "valid_tool_names", ()),
                    local=os.environ.get("TERMINAL_ENV", "local").lower() == "local",
                    supported=(getattr(agent, "api_mode", "") == "chat_completions" if mode == "shadow"
                               else context_protocol_supported(agent)), query=request)
            except Exception:
                agent._baiqiu_context_metrics = {"contextPolicy": "off", "contextArchiveFailures": 1}
                logging.getLogger(__name__).warning("Context selection failed; keeping full request")
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


def bind_provider_usage(agent, conn, session_id, loop):
    import acp
    import threading
    from acp_adapter.events import _send_update
    try:
        from agent.usage_pricing import normalize_usage
    except ImportError:
        return lambda: None

    bindings = []
    local = threading.local()

    def bind(name):
        previous = getattr(agent, name, None)
        if not callable(previous):
            return
        had_own = name in agent.__dict__

        def observed(*args, **kwargs):
            nested = getattr(local, "active", False)
            local.active = True
            try:
                response = previous(*args, **kwargs)
            finally:
                local.active = nested
            if not nested and getattr(response, "usage", None):
                try:
                    usage = normalize_usage(response.usage, provider=agent.provider, api_mode=agent.api_mode)
                    update = acp.update_agent_message_text("")
                    update.field_meta = {"baiqiu_diagnostic": {
                        "type": "provider_usage", "requestId": str(uuid.uuid4()),
                        "inputTokens": usage.prompt_tokens, "outputTokens": usage.output_tokens,
                        "totalTokens": usage.total_tokens, "timestamp": time.time_ns() // 1_000_000,
                    }}
                    for source, target in (("cache_read_tokens", "cacheReadTokens"), ("cache_write_tokens", "cacheWriteTokens")):
                        value = getattr(usage, source, None)
                        if isinstance(value, int) and value >= 0:
                            update.field_meta["baiqiu_diagnostic"][target] = value
                    _send_update(conn, session_id, loop, update)
                except Exception:
                    logging.getLogger(__name__).debug("Provider usage delivery failed", exc_info=True)
            return response

        setattr(agent, name, observed)
        bindings.append((name, previous, observed, had_own))

    for name in ("_interruptible_api_call", "_interruptible_streaming_api_call"):
        bind(name)

    def restore():
        for name, previous, observed, had_own in bindings:
            if getattr(agent, name, None) is observed:
                if had_own:
                    setattr(agent, name, previous)
                else:
                    delattr(agent, name)
    return restore


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
                if chunk and observed_at - self.last_activity_at >= 0.25:
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
                **context_request_profile(body),
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
        publish("client_prepare", request_id,
                **context_request_profile(api_kwargs),
                **getattr(agent, "_baiqiu_context_metrics", {}),
                toolCount=len(api_kwargs.get("tools") or []),
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
    original_build = getattr(agent, "_build_api_kwargs", None)
    had_build = "_build_api_kwargs" in agent.__dict__

    def build_request(messages, *args, **kwargs):
        identity = str(uuid.uuid4())
        publish("context_prepare", identity)
        request = original_build(messages, *args, **kwargs)
        publish("context_ready", identity, **context_request_profile(request),
                **getattr(agent, "_baiqiu_context_metrics", {}))
        return request

    if callable(original_build):
        agent._build_api_kwargs = build_request

    def restore():
        if getattr(agent, "_build_api_kwargs", None) is build_request:
            if had_build:
                agent._build_api_kwargs = original_build
            else:
                del agent._build_api_kwargs
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
    from baiqiu_windows_process import install_windows_probe_guard
    install_windows_probe_guard()
    install_tool_completion_compat()
    from baiqiu_tool_execution import install_tool_execution
    try:
        install_tool_execution()
    except (RuntimeError, AttributeError):
        logging.getLogger(__name__).exception("Tool execution compatibility mismatch; retaining native runtime")
    from baiqiu_protocol_recovery import install_protocol_recovery, bind_protocol_recovery
    install_protocol_recovery()
    manager = session_manager_class(SessionManager, load_config)()

    logger = logging.getLogger(__name__)

    class BaiqiuACPAgent(HermesACPAgent):
        def on_connect(self, conn):
            from baiqiu_run_state import RunStateStore, ObservedConnection
            self.run_states = RunStateStore(Path(os.environ["HERMES_HOME"]) / "baiqiu-runs")
            super().on_connect(ObservedConnection(conn, self.run_states))

        async def ext_method(self, method, params):
            if method == "baiqiu/supplement":
                session_id = str(params.get("sessionId", ""))
                turn_id = str(params.get("turnId", ""))
                state = self.session_manager.get_session(session_id)
                channel = getattr(state, "_baiqiu_supplements", None)
                if channel and channel.record["turnId"] == turn_id:
                    receipt = await asyncio.to_thread(channel.receive, params.get("supplementId"), params.get("text"))
                else:
                    snapshot = self.run_states.snapshot(session_id, turn_id)
                    item = snapshot.get("supplements", {}).get(params.get("supplementId"))
                    if item and item["text"] != params.get("text"):
                        raise ValueError("Conflicting supplement identity")
                    receipt = dict(accepted=bool(item), status=item["status"] if item else "not_running",
                                   supplementId=params.get("supplementId"))
                return dict(receipt, sessionId=session_id, turnId=turn_id)
            if method != "baiqiu/run_status":
                raise acp.RequestError.method_not_found(method)
            return self.run_states.snapshot(str(params.get("sessionId", "")),
                                            str(params.get("turnId", "")), params.get("afterSequence"))

        async def cancel(self, session_id, **kwargs):
            state = self.session_manager.get_session(session_id)
            if state is not None:
                state._baiqiu_cancel_revision = getattr(state, "_baiqiu_cancel_revision", 0) + 1
            return await super().cancel(session_id, **kwargs)

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
            turn_id = (getattr(prompt[0], "field_meta", None) or {}).get("baiqiuTurnId", "") if prompt else ""
            if not state or not turn_id:
                return await self._prompt_with_status(prompt, session_id, **kwargs)
            if not await wait_for_session_idle(state, self._conn, session_id, turn_id):
                return acp.schema.PromptResponse(stop_reason="cancelled")
            record = self.run_states.begin(session_id, turn_id)
            try:
                response = await self._prompt_with_status(prompt, session_id, **kwargs)
            except BaseException:
                self.run_states.finish(record, "error", error=True)
                raise
            outcome = self.run_states.finish(record, response.stop_reason)
            response.field_meta = {**(response.field_meta or {}), "baiqiuRun": outcome}
            return response

        async def _prompt_with_status(self, prompt, session_id, **kwargs):
            state = self.session_manager.get_session(session_id)
            if state is None or not self._conn:
                return await super().prompt(prompt, session_id, **kwargs)
            turn_id = (getattr(prompt[0], "field_meta", None) or {}).get("baiqiuTurnId", "") if prompt else ""
            if not await wait_for_session_idle(state, self._conn, session_id, turn_id):
                return acp.schema.PromptResponse(stop_reason="cancelled")
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
            restore_usage = bind_provider_usage(agent, self._conn, session_id, asyncio.get_running_loop())
            restore_context = bind_runtime_context(agent, previous_interrupted)
            from baiqiu_async_delivery import bind_async_delivery
            finish_delivery = bind_async_delivery(state)
            delivery_run = agent.run_conversation
            record = self.run_states.active.get(session_id)
            from baiqiu_supplements import TurnSupplements, bind_supplements
            from acp_adapter.events import _send_update
            event_loop = asyncio.get_running_loop()

            def publish_supplement(diagnostic):
                update = acp.update_agent_message_text("")
                update.field_meta = {"baiqiu_diagnostic": diagnostic}
                _send_update(self._conn, session_id, event_loop, update)

            supplements = TurnSupplements(agent, record, publish_supplement,
                lambda: bool(state.cancel_event and state.cancel_event.is_set()),
                self.run_states.checkpoint) if record else None
            state._baiqiu_supplements = supplements

            def tracked_run(*args, **options):
                result = delivery_run(*args, **options)
                while supplements:
                    continuation = supplements.finish_or_continue(result)
                    if not continuation:
                        break
                    next_result = delivery_run(user_message=continuation,
                        conversation_history=result.get("messages") or [], task_id=session_id,
                        persist_user_message=continuation)
                    for key in ("prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens", "cache_read_tokens"):
                        if result.get(key) is not None or next_result.get(key) is not None:
                            next_result[key] = (result.get(key) or 0) + (next_result.get(key) or 0)
                    result = next_result
                stage_delivery = getattr(agent, "_baiqiu_stage_delivery", None)
                if record and stage_delivery and stage_delivery.terminal_delivery:
                    record["completion"] = stage_delivery.terminal_delivery
                return self.run_states.capture(record, result) if record else result

            agent.run_conversation = tracked_run
            delivery_succeeded = False
            recovery, restore_recovery = bind_protocol_recovery(
                agent, self._conn, session_id, asyncio.get_running_loop(),
                lambda: bool(state.cancel_event and state.cancel_event.is_set()),
                turn_id=(getattr(prompt[0], "field_meta", None) or {}).get("baiqiuTurnId", "") if prompt else "",
                history=state.history)
            restore_stage_delivery = lambda: None
            restore_supplements = lambda: None
            try:
                if any("[Black Ball event ownership / Public structured progress protocol]" in str(getattr(block, "text", "")) for block in prompt):
                    from baiqiu_stage_delivery import bind_stage_delivery
                    stage_delivery, restore_stage_delivery = bind_stage_delivery(
                        agent, self._conn, session_id, asyncio.get_running_loop(),
                        lambda: bool(state.cancel_event and state.cancel_event.is_set()), turn_id, state.history)
                    stage_delivery.supplements = supplements
                if supplements and callable(getattr(agent, "_build_api_kwargs", None)):
                    restore_supplements = bind_supplements(agent, supplements)
                response = await super().prompt(prompt, session_id, **kwargs)
                delivery_succeeded = response.stop_reason == "end_turn" and not recovery.pending
                if response.stop_reason != "cancelled" and recovery.pending:
                    response.stop_reason = "refusal"
                return response
            finally:
                restore_supplements()
                if getattr(state, "_baiqiu_supplements", None) is supplements:
                    del state._baiqiu_supplements
                restore_stage_delivery()
                restore_recovery()
                if agent.run_conversation is tracked_run:
                    agent.run_conversation = delivery_run
                finish_delivery(delivery_succeeded)
                restore_context()
                restore_timings()
                restore_usage()
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
