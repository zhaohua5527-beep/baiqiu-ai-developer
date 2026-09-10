import asyncio
import json
import logging
import os
import sqlite3
import time
from pathlib import Path


logger = logging.getLogger(__name__)


def read_delivery_rows(session_id, db_path=None):
    if db_path is None:
        from hermes_constants import get_hermes_home
        db_path = Path(get_hermes_home()) / "state.db"
    path = Path(db_path)
    if not path.exists():
        return []
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='async_delegations'").fetchone():
            return []
        return [dict(row) for row in connection.execute(
            "SELECT * FROM async_delegations WHERE origin_session=? AND delivery_state='pending' "
            "ORDER BY dispatched_at, delegation_id", (session_id,)
        )]
    finally:
        connection.close()


def is_acp_completion(event, db_path=None):
    if event.get("type") != "async_delegation":
        return False
    session_id = str(event.get("session_key") or "")
    if not session_id:
        return False
    if db_path is None:
        from hermes_constants import get_hermes_home
        db_path = Path(get_hermes_home()) / "state.db"
    path = Path(db_path)
    if not path.exists():
        return False
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT source FROM sessions WHERE id=?", (session_id,)).fetchone()
        return bool(row and row[0] == "acp")
    finally:
        connection.close()


def install_gateway_delivery_guard(runner_class):
    previous = runner_class._deliver_completion_notification
    if getattr(previous, "_baiqiu_acp_guard", False):
        return

    async def deliver(self, text, event):
        if await asyncio.to_thread(is_acp_completion, event):
            logger.info("Leaving ACP completion %s for its session consumer", event.get("delegation_id"))
            return None
        return await previous(self, text, event)

    deliver._baiqiu_acp_guard = True
    runner_class._deliver_completion_notification = deliver


def completion_in_history(history, marker):
    for index, message in enumerate(history):
        if message.get("role") != "user" or message.get("content") != marker:
            continue
        for following in history[index + 1:]:
            if following.get("role") == "user":
                break
            if following.get("role") == "assistant" and following.get("content") and not following.get("tool_calls"):
                return True
    return False


def bind_async_delivery(state):
    from tools import async_delegation as delivery
    from tools.process_registry import format_process_notification

    agent = state.agent
    previous = agent.run_conversation
    had_own = "run_conversation" in agent.__dict__
    claims = []
    consumed = set()
    recovered = set()

    def cancelled():
        return bool(state.cancel_event and state.cancel_event.is_set())

    def run(*args, **kwargs):
        result = previous(*args, **kwargs)
        while not result.get("interrupted") and not result.get("error") and not cancelled():
            rows = [row for row in read_delivery_rows(state.session_id) if row["delegation_id"] not in consumed]
            if not rows:
                break
            rows.sort(key=lambda row: (row["state"] in ("running", "finalizing"), row.get("completed_at") or row["dispatched_at"]))
            row = rows[0]
            if row["state"] in ("running", "finalizing"):
                if row.get("owner_pid") != os.getpid() and row["delegation_id"] not in recovered:
                    delivery.recover_abandoned_delegations()
                    recovered.add(row["delegation_id"])
                if state.cancel_event:
                    state.cancel_event.wait(0.1)
                else:
                    time.sleep(0.1)
                continue
            event = json.loads(row.get("event_json") or "null")
            if not isinstance(event, dict) or event.get("session_key") != state.session_id:
                raise RuntimeError("ACP delegation completion is missing its original session event")
            claim = delivery.claim_event_delivery(event, "baiqiu-acp")
            if claim is None:
                raise RuntimeError("ACP delegation completion is owned by another delivery consumer")
            claims.append((event, claim))
            marker = format_process_notification(event)
            if not marker:
                raise RuntimeError("ACP delegation completion has no native notification")
            history = result.get("messages") or []
            consumed.add(row["delegation_id"])
            if completion_in_history(history, marker):
                continue
            next_result = previous(
                user_message=marker, conversation_history=history,
                task_id=state.session_id, persist_user_message=marker,
            )
            for key in ("prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens", "cache_read_tokens"):
                if result.get(key) is not None or next_result.get(key) is not None:
                    next_result[key] = (result.get(key) or 0) + (next_result.get(key) or 0)
            result = next_result
        if cancelled():
            delivery.interrupt_for_session(session_key=state.session_id, reason="ACP request cancelled")
            result = {**result, "interrupted": True}
        return result

    agent.run_conversation = run

    def finish(success):
        if agent.run_conversation is run:
            if had_own:
                agent.run_conversation = previous
            else:
                del agent.run_conversation
        for event, claim in claims:
            marker = format_process_notification(event)
            if success and not cancelled() and completion_in_history(state.history, marker):
                delivery.complete_event_delivery(event, claim)
            else:
                delivery.release_event_delivery(event, claim)

    return finish
