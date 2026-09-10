import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
sys.path.insert(0, os.environ["BAIQIU_TEST_AGENT_ROOT"])
temporary_home = tempfile.TemporaryDirectory(prefix="baiqiu-async-delivery-")
os.environ["HERMES_HOME"] = temporary_home.name

from tools import async_delegation as delivery
from tools.process_registry import format_process_notification
import baiqiu_async_delivery as bridge


class AsyncDeliveryTest(unittest.TestCase):
    def setUp(self):
        delivery._reset_for_tests()
        self.home = tempfile.TemporaryDirectory(dir=temporary_home.name)
        self.db_path = Path(self.home.name) / "state.db"
        self.db_patch = patch.object(delivery, "_db_path", return_value=self.db_path)
        self.db_patch.start()
        with delivery._transaction() as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT)")
            connection.executemany("INSERT INTO sessions VALUES (?,?)", [("desktop", "acp"), ("other", "acp"), ("wechat", "weixin")])
        self.claims = []

    def tearDown(self):
        self.db_patch.stop()
        self.home.cleanup()

    def record(self, identity="deleg_fixture", session="desktop", status="completed", batch=False):
        delivery._persist_dispatch({"delegation_id": identity, "session_key": session,
                                    "parent_session_id": session, "dispatched_at": 1, "goal": "fixture"})
        event = {"type": "async_delegation", "delegation_id": identity, "session_key": session,
                 "parent_session_id": session, "status": status, "goal": "fixture",
                 "dispatched_at": 1, "completed_at": 2, "summary": "fixture result"}
        if batch:
            event.update(is_batch=True, goals=["one", "two"], results=[
                {"task_index": 0, "status": "completed", "summary": "first"},
                {"task_index": 1, "status": "completed", "summary": "second"}])
        if status != "running":
            delivery._persist_completion(event, event)
        return event

    def state(self, fail=False, cancel=False):
        calls = []
        state = SimpleNamespace(session_id="desktop", cancel_event=threading.Event(), history=[])

        def run(**kwargs):
            calls.append(kwargs)
            if fail and len(calls) > 1:
                raise RuntimeError("connection lost")
            if cancel:
                state.cancel_event.set()
            history = [*(kwargs.get("conversation_history") or []),
                       {"role": "user", "content": kwargs["user_message"]},
                       {"role": "assistant", "content": "fixture reply"}]
            return {"messages": history, "final_response": "fixture reply", "total_tokens": 3}

        state.agent = SimpleNamespace(run_conversation=run)
        return state, calls

    def run_bound(self, state):
        original_read = bridge.read_delivery_rows
        with patch.object(bridge, "read_delivery_rows", side_effect=lambda session: original_read(session, self.db_path)):
            finish = bridge.bind_async_delivery(state)
            try:
                result = state.agent.run_conversation(user_message="request", conversation_history=state.history)
                state.history = result["messages"]
            except Exception:
                finish(False)
                raise
            finish(not result.get("interrupted"))
            return result

    def test_native_durable_completion_returns_to_parent_once_and_keeps_other_session(self):
        event = self.record(batch=True)
        self.record("deleg_other", "other")
        state, calls = self.state()
        result = self.run_bound(state)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["user_message"], format_process_notification(event))
        self.assertEqual(result["total_tokens"], 6)
        self.assertEqual(delivery.get_durable_delegation("deleg_fixture")["delivery_state"], "delivered")
        self.assertEqual(delivery.get_durable_delegation("deleg_other")["delivery_attempts"], 0)
        self.run_bound(state)
        self.assertEqual(len(calls), 3)

    def test_failed_delivery_releases_claim_without_losing_result(self):
        self.record()
        state, calls = self.state(fail=True)
        with self.assertRaisesRegex(RuntimeError, "connection lost"):
            self.run_bound(state)
        row = delivery.get_durable_delegation("deleg_fixture")
        self.assertEqual(row["delivery_state"], "pending")
        self.assertNotIn("delivery_claim", row)
        self.assertEqual(row["state"], "completed")

    def test_cancel_does_not_start_continuation(self):
        self.record()
        state, calls = self.state(cancel=True)
        result = self.run_bound(state)
        self.assertTrue(result["interrupted"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(delivery.get_durable_delegation("deleg_fixture")["delivery_attempts"], 0)

    def test_restored_transcript_acknowledges_without_rerunning_completed_continuation(self):
        event = self.record()
        state, calls = self.state()
        state.history = [{"role": "user", "content": format_process_notification(event)},
                         {"role": "assistant", "content": "persisted reply"}]
        self.run_bound(state)
        self.assertEqual(len(calls), 1)
        self.assertEqual(delivery.get_durable_delegation("deleg_fixture")["delivery_state"], "delivered")

    def test_another_consumer_claim_is_not_overridden(self):
        self.record()
        self.assertTrue(delivery.claim_completion_delivery("deleg_fixture", "other-process"))
        state, calls = self.state()
        with self.assertRaisesRegex(RuntimeError, "another delivery consumer"):
            self.run_bound(state)
        self.assertEqual(len(calls), 1)
        self.assertEqual(delivery.get_durable_delegation("deleg_fixture")["delivery_state"], "pending")

    def test_gateway_does_not_claim_acp_but_preserves_wechat_delivery(self):
        event = self.record()
        calls = []

        class Runner:
            async def _deliver_completion_notification(self, text, value):
                calls.append(value)
                return True

        original_check = bridge.is_acp_completion
        with patch.object(bridge, "is_acp_completion", side_effect=lambda value: original_check(value, self.db_path)):
            bridge.install_gateway_delivery_guard(Runner)
            bridge.install_gateway_delivery_guard(Runner)
            self.assertIsNone(asyncio.run(Runner()._deliver_completion_notification("fixture", event)))
            self.assertTrue(asyncio.run(Runner()._deliver_completion_notification("fixture", {**event, "session_key": "wechat"})))
        self.assertEqual(len(calls), 1)
        self.assertEqual(delivery.get_durable_delegation("deleg_fixture")["delivery_attempts"], 0)

    def test_unknown_worker_outcome_is_returned_as_failure_evidence(self):
        event = self.record(status="unknown")
        state, calls = self.state()
        self.run_bound(state)
        self.assertEqual(calls[1]["user_message"], format_process_notification(event))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary_home.cleanup()
