#!/usr/bin/env python3
"""Run a verified Hermes delegation without asking a model to emit the tool call.

The desktop project orchestrator already has the complete assignment contract.
This bridge uses Hermes' own AIAgent and delegate_task implementation directly,
so the model is still used by each leaf worker, but batch creation is local and
deterministic.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import traceback
from pathlib import Path


def _stderr(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def _load_request() -> dict:
    raw = sys.stdin.read()
    value = json.loads(raw or "{}")
    if not isinstance(value, dict):
        raise ValueError("Direct Hermes delegation request must be an object.")
    return value


def _capture_live_delegation_id(protocol_stdout):
    import tools.delegation_live_log as live_log

    captured = {"delegation_id": ""}
    original = live_log.create_live_transcripts

    def wrapped(*args, **kwargs):
        result = original(*args, **kwargs)
        if isinstance(result, tuple) and result:
            captured["delegation_id"] = str(result[0] or "")
            protocol_stdout.write(json.dumps({
                "type": "delegation",
                "delegationId": captured["delegation_id"],
            }, ensure_ascii=False) + "\n")
            protocol_stdout.flush()
        return result

    live_log.create_live_transcripts = wrapped
    return captured


def _content_to_text(content) -> str:
    """Normalize Hermes assistant content without losing structured text blocks."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                value = item.get("text")
                if isinstance(value, str):
                    parts.append(value)
            elif item is not None:
                parts.append(str(item))
        return "\n".join(parts)
    if isinstance(content, dict):
        value = content.get("text")
        return value if isinstance(value, str) else ""
    return str(content)


def _last_complete_assistant_message(child) -> str:
    """Return the last persisted in-memory assistant answer from a child.

    Hermes may expose a short post-processing note as ``final_response`` while
    the canonical assistant message is still present in ``_session_messages``.
    The latter is the same transcript that Hermes persists to state.db, so it
    is the authoritative result for project delivery.
    """
    messages = getattr(child, "_session_messages", None)
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        if message.get("tool_calls") and not _content_to_text(message.get("content")).strip():
            continue
        if message.get("_empty_terminal_sentinel"):
            continue
        text = _content_to_text(message.get("content")).strip()
        if text and text != "(empty)":
            return text
    return ""


def _install_full_result_recovery(delegate_module) -> None:
    """Make direct delegation recover full child output before aggregation."""
    original = getattr(delegate_module, "_run_single_child", None)
    if not callable(original) or getattr(original, "_baiqiu_full_result_recovery", False):
        return

    def wrapped(*args, **kwargs):
        child = kwargs.get("child")
        if child is None and len(args) >= 3:
            child = args[2]
        result = original(*args, **kwargs)
        if not isinstance(result, dict) or child is None:
            return result
        full_text = _last_complete_assistant_message(child)
        summary = _content_to_text(result.get("summary")).strip()
        if full_text and len(full_text) > len(summary):
            result["summary"] = full_text
            result["summary_source"] = "hermes_session_messages"
            result["summary_recovered"] = True
        return result

    wrapped._baiqiu_full_result_recovery = True
    delegate_module._run_single_child = wrapped


def main() -> int:
    request = _load_request()
    hermes_root = Path(str(request.get("hermesRoot") or "")).expanduser().resolve()
    agent_root_raw = str(request.get("agentRoot") or "").strip()
    hermes_agent_root = Path(agent_root_raw).expanduser().resolve() if agent_root_raw else hermes_root / "hermes-agent"
    if not hermes_agent_root.is_dir():
        raise FileNotFoundError(f"Hermes runtime was not found: {hermes_agent_root}")

    os.environ.setdefault("HERMES_HOME", str(hermes_root))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONUTF8", "1")
    sys.path.insert(0, str(hermes_agent_root))
    site_packages = hermes_agent_root / "venv" / "Lib" / "site-packages"
    if site_packages.is_dir():
        sys.path.insert(0, str(site_packages))

    # Hermes bootstrap and dotenv loading must happen before AIAgent creation.
    try:
        import hermes_bootstrap  # noqa: F401
    except ModuleNotFoundError:
        pass
    from hermes_constants import get_hermes_home
    from hermes_cli.env_loader import load_hermes_dotenv

    load_hermes_dotenv(hermes_home=get_hermes_home())

    from acp_adapter.session import SessionManager
    import tools.delegate_tool as delegate_module

    _install_full_result_recovery(delegate_module)
    delegate_task = delegate_module.delegate_task

    workspace = str(request.get("workspace") or os.getcwd())
    parent_session_id = str(request.get("parentSessionId") or "").strip()
    if not parent_session_id:
        raise ValueError("A parent session id is required for direct delegation.")
    tasks = request.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError("Direct Hermes delegation requires a non-empty tasks array.")

    # Keep all human-readable Hermes output off stdout; stdout is the bridge
    # protocol and must contain exactly one JSON response.
    protocol_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        manager = SessionManager()
        parent = manager._make_agent(
            session_id=parent_session_id,
            cwd=workspace,
        )
        parent._print_fn = _stderr
        captured = _capture_live_delegation_id(protocol_stdout)
        raw_result = delegate_task(
            tasks=tasks,
            background=False,
            parent_agent=parent,
        )

    result = json.loads(raw_result) if isinstance(raw_result, str) else raw_result
    if not isinstance(result, dict):
        raise ValueError("Hermes direct delegation returned a non-object result.")
    delegation_id = str(captured.get("delegation_id") or "").strip()
    if not delegation_id:
        raise RuntimeError("Hermes direct delegation did not produce a live delegation id.")

    response = {
        "ok": True,
        "hermesSessionId": str(getattr(parent, "session_id", parent_session_id) or parent_session_id),
        "delegationId": delegation_id,
        "results": result.get("results") if isinstance(result.get("results"), list) else [],
        "liveTranscripts": result.get("live_transcripts") if isinstance(result.get("live_transcripts"), list) else [],
        "totalDurationSeconds": result.get("total_duration_seconds"),
    }
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        _stderr(traceback.format_exc())
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": str(error),
            "errorType": type(error).__name__,
        }, ensure_ascii=False) + "\n")
        raise SystemExit(1)
