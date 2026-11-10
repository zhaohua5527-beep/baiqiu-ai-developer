import copy
import inspect
import json
import re
import threading
import time
import uuid

from baiqiu_stage_delivery import progress_blocks


def protocol_fault(content):
    if not isinstance(content, str):
        return ""
    blocks = progress_blocks(content)
    for start, end, value in blocks:
        if value is not None:
            continue
        payload = content[start + len("<baiqiu-progress>"):end].lstrip()
        if not content[:end].lower().endswith("</baiqiu-progress>"):
            try:
                json.JSONDecoder().raw_decode(payload)
                return "unclosed_progress"
            except ValueError:
                return "invalid_progress_json"
        return "invalid_progress_json"
    source = content
    for start, end, _ in reversed(blocks):
        source = source[:start] + source[end:]
    source = re.sub(r"```[^\n]*\n[\s\S]*?(?:```|$)|`[^`\n]*`", "", source)
    if re.search(r"(?m)^\s*</?[｜|]{1,2}DSML[｜|]{1,2}\s+(?:calls|invoke|parameter)\b", source):
        return "leaked_tool_protocol"
    return ""


def bounded_progress_with_answer(content):
    blocks = progress_blocks(content)
    if not blocks:
        return False
    remaining = content
    for start, end, value in reversed(blocks):
        if value is None:
            payload = content[start:end]
            if not payload.lower().endswith("</baiqiu-progress>"):
                return False
            inner = payload[len("<baiqiu-progress>"):-len("</baiqiu-progress>")]
            if not re.search(r'"segmentId"\s*:\s*"[^"\r\n]+"', inner) or re.search(r"</?(?:baiqiu-|[｜|]{1,2}DSML)", inner, re.I):
                return False
        remaining = remaining[:start] + remaining[end:]
    remaining = re.sub(r"<baiqiu-(presentation|outcome|clarification|outline)>[\s\S]*?</baiqiu-\1>", "", remaining, flags=re.I)
    return bool(remaining.strip()) and not re.search(r"</?(?:baiqiu-|[｜|]{1,2}DSML)", remaining, re.I)


def progress_only_without_answer(content):
    """Identify public progress that contains no final public answer."""
    blocks = progress_blocks(content)
    if not blocks or any(value is None for _, _, value in blocks):
        return False
    if not any(value.get("type") in ("stage_result", "cross") for _, _, value in blocks):
        return False
    remaining = content
    for start, end, _ in reversed(blocks):
        remaining = remaining[:start] + remaining[end:]
    remaining = re.sub(r"<baiqiu-(presentation|outcome|clarification|outline)>[\s\S]*?</baiqiu-\1>", "", remaining, flags=re.I)
    return not remaining.strip()


def tool_signature(name, arguments):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except ValueError:
            return None
    if not isinstance(arguments, dict):
        return None
    return name, json.dumps(arguments, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def completed_tools(messages):
    calls = {}
    results = {}
    uncertain = set()
    for message in messages:
        if message.get("role") == "assistant":
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                signature = tool_signature(function.get("name"), function.get("arguments"))
                if signature:
                    calls[call.get("id")] = signature
        elif message.get("role") == "tool":
            signature = calls.pop(message.get("tool_call_id"), None)
            if not signature:
                continue
            if message.get("effect_disposition") == "unknown":
                uncertain.add(signature)
            else:
                results[signature] = copy.deepcopy(message.get("content"))
    return results, uncertain, bool(calls)


class ProtocolRecovery:
    def __init__(self, publish, cancelled=lambda: False, turn_id="", history=()):
        self.publish = publish
        self.cancelled = cancelled
        self.attempts = 0
        self.sequence = 0
        self.pending = False
        self.failed = False
        self.start = None
        self.results = {}
        self.uncertain = set()
        self.unsettled = False
        self.lock = threading.Lock()
        self.turn_id = turn_id if isinstance(turn_id, str) else ""
        self.tool_ids = set()
        for message in history:
            metadata = message.get("display_metadata") or {}
            checkpoint = metadata.get("baiqiuProtocolRecovery", {}) if isinstance(metadata, dict) else {}
            if self.turn_id and isinstance(checkpoint, dict) and checkpoint.get("turnId") == self.turn_id:
                attempts = checkpoint.get("attempts", 0)
                if isinstance(attempts, int) and not isinstance(attempts, bool):
                    self.attempts = max(self.attempts, min(2, attempts))
                tool_ids = checkpoint.get("toolIds")
                if isinstance(tool_ids, list):
                    self.tool_ids.update(ident for ident in tool_ids if isinstance(ident, str) and ident)
        if self.tool_ids:
            previous = [dict(message, tool_calls=[call for call in (message.get("tool_calls") or [])
                if call.get("id") in self.tool_ids]) if message.get("role") == "assistant" else message
                for message in history if message.get("role") == "assistant" or message.get("tool_call_id") in self.tool_ids]
            self.results, self.uncertain, self.unsettled = completed_tools(previous)

    def event(self, phase, reason):
        self.sequence += 1
        self.publish({"type": "protocol_recovery", "phase": phase, "reason": reason,
                      "sequence": self.sequence,
                      "attempt": self.attempts, "eventId": "protocol-recovery:" + str(uuid.uuid4()),
                      "timestamp": time.time_ns() // 1_000_000})

    def inspect(self, agent, response, messages, history, turn_start=None):
        if self.start is None:
            self.start = len(messages)
        if turn_start is not None:
            self.start = turn_start
        if self.cancelled() or getattr(agent, "_interrupt_requested", False):
            return "cancelled"
        reason = protocol_fault(response.content)
        stage_delivery = getattr(agent, "_baiqiu_stage_delivery", None)
        if (not reason and not response.tool_calls and not getattr(stage_delivery, "terminal_delivery", None)
                and progress_only_without_answer(response.content)):
            reason = "missing_public_answer"
        if not reason:
            if self.pending and (response.content or response.tool_calls):
                self.pending = False
                self.event("recovered", "valid_response")
            return ""
        if response.tool_calls:
            return ""
        _, uncertain, unsettled = completed_tools(messages[self.start:])
        if reason == "invalid_progress_json" and response.finish_reason == "stop" and not uncertain and not unsettled and not self.unsettled and bounded_progress_with_answer(response.content):
            self.pending = False
            self.event("warning", "invalid_bounded_progress")
            return ""
        self.pending = True
        results, uncertain, unsettled = completed_tools(messages[self.start:])
        self.results.update(results)
        self.uncertain.update(uncertain)
        self.tool_ids.update(call.get("id") for message in messages[self.start:]
            for call in message.get("tool_calls") or [] if call.get("id"))
        unsettled = unsettled or self.unsettled
        exhausted = self.attempts >= 2 or unsettled
        if not exhausted:
            self.attempts += 1
        interim = agent._build_assistant_message(response, response.finish_reason)
        interim["display_metadata"] = {**(interim.get("display_metadata") or {}),
            "baiqiuProtocolRecovery": {"turnId": self.turn_id, "attempts": self.attempts, "toolIds": sorted(self.tool_ids)}}
        messages.append(interim)
        agent._session_messages = messages
        persisted = agent._flush_messages_to_session_db(messages, history)
        agent._emit_interim_assistant_message(interim)
        if persisted is False:
            self.failed = True
            self.event("failed", "checkpoint_persistence_failed")
            return "failed"
        if exhausted:
            self.failed = True
            self.event("failed", "unsettled_tools" if unsettled else reason)
            return "failed"
        messages.append({"role": "user", "content": (
            "[Runtime protocol recovery] Your last public response contained an invalid protocol envelope. "
            "The current user task is still active. Preserve all completed tool results above; do not repeat "
            "completed actions or replay the original request. Emit only new public progress and the next "
            "necessary native tool calls, or a valid final answer if the task is complete. Do not repeat "
            "any previously delivered answer. Recover only the missing public content. The previous response "
            "contained public progress but no final public answer; if the active task is complete, emit the "
            "ordinary user-facing answer now, or emit a valid taskCompletion declaration on the last stage "
            "result when that stage result is the complete deliverable. For stage results use "
            "baiqiu-progress v2: a JSON metadata line with schemaVersion:2 and no message field, followed by "
            "raw Markdown and a closing tag on its own line. Close every "
            "baiqiu-progress JSON envelope with </baiqiu-progress>. Never emit DSML serialization as text. "
            "For actions with uncertain effects, inspect their real state before doing anything further."
        ), "_pre_verify_synthetic": True})
        self.event("retrying", reason)
        return "retry"

    def reuse(self, name, arguments):
        signature = tool_signature(name, arguments)
        with self.lock:
            if signature in self.uncertain:
                return True, json.dumps({"error": "execution_state_unknown",
                    "message": "前次调用的实际执行状态不确定。请先核实状态，不要直接重复该动作。"}, ensure_ascii=False), True
            if signature in self.results:
                return True, copy.deepcopy(self.results[signature]), False
        return False, None, False


def install_protocol_recovery():
    from agent import conversation_loop, tool_executor
    from baiqiu_tool_execution import compile_function, replace_once
    if getattr(conversation_loop, "_baiqiu_protocol_recovery_installed", False):
        return
    original = conversation_loop.run_conversation
    source = inspect.getsource(original)
    source = replace_once(source, "            # Handle assistant response\n", (
        "            _stage_delivery = getattr(agent, '_baiqiu_stage_delivery', None)\n"
        "            if _stage_delivery is not None:\n"
        "                try:\n"
        "                    _stage_delivery.observe(assistant_message, messages[current_turn_user_idx + 1:])\n"
        "                except Exception:\n"
        "                    logger.exception('Stage delivery inspection unavailable; continuing task')\n"
        "            _public_recovery = getattr(agent, '_baiqiu_protocol_recovery', None)\n"
        "            if _public_recovery is not None:\n"
        "                _public_action = _public_recovery.inspect(agent, assistant_message, messages, conversation_history, current_turn_user_idx + 1)\n"
        "                if _public_action == 'retry':\n"
        "                    continue\n"
        "                if _public_action == 'cancelled':\n"
        "                    interrupted = True\n"
        "                    break\n"
        "                if _public_action == 'failed':\n"
        "                    agent._cleanup_task_resources(effective_task_id)\n"
        "                    agent._persist_session(messages, conversation_history)\n"
        "                    return {'final_response': '', 'messages': messages, 'api_calls': api_call_count,\n"
        "                            'completed': False, 'partial': True, 'error': 'invalid_public_protocol'}\n\n"
        "            # Handle assistant response\n"
    ))
    patched = compile_function(original, source)
    middleware = tool_executor._run_agent_tool_execution_middleware

    def guarded_tool(agent, **kwargs):
        recovery = getattr(agent, "_baiqiu_protocol_recovery", None)
        if recovery is not None and recovery.attempts:
            if recovery.cancelled() or getattr(agent, "_interrupt_requested", False):
                raise KeyboardInterrupt()
            found, result, blocked = recovery.reuse(kwargs["function_name"], kwargs["function_args"])
            if recovery.cancelled() or getattr(agent, "_interrupt_requested", False):
                raise KeyboardInterrupt()
            if found:
                begin = kwargs.get("begin_execution")
                if begin is not None:
                    begin(None)
                return tool_executor._ManagedToolResult(result=result, args=kwargs["function_args"],
                    middleware_trace=[{"source": "protocol_recovery", "reused": not blocked}], blocked=blocked)
        return middleware(agent, **kwargs)

    conversation_loop.run_conversation = patched
    tool_executor._run_agent_tool_execution_middleware = guarded_tool
    conversation_loop._baiqiu_protocol_recovery_installed = True


def bind_protocol_recovery(agent, conn, session_id, loop, cancelled, turn_id="", history=()):
    import acp
    from acp_adapter.events import _send_update

    def publish(diagnostic):
        update = acp.update_agent_message_text("")
        update.field_meta = {"baiqiu_diagnostic": diagnostic}
        _send_update(conn, session_id, loop, update)

    recovery = ProtocolRecovery(publish, cancelled, turn_id, history)
    agent._baiqiu_protocol_recovery = recovery

    def restore():
        if getattr(agent, "_baiqiu_protocol_recovery", None) is recovery:
            del agent._baiqiu_protocol_recovery

    return recovery, restore
