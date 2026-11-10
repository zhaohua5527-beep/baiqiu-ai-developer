import json
import ast
import asyncio
import logging
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_run_state import RunStateStore


class Update:
    def __init__(self, **payload):
        self.payload = payload
        self.field_meta = None

    def model_dump(self, **kwargs):
        return dict(self.payload)


class RunStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = RunStateStore(self.directory.name)
        self.record = self.store.begin("session", "turn")

    def test_stage_complete_is_not_turn_complete(self):
        self.store.observe("session", Update(sessionUpdate="agent_message_chunk", content={"text": "阶段完成"}))
        self.store.observe("session", Update(sessionUpdate="tool_call", toolCallId="search", status="in_progress"))
        self.assertEqual(self.store.snapshot("session", "turn")["status"], "running")
        self.store.capture(self.record, {"completed": True})
        outcome = self.store.finish(self.record, "end_turn")
        self.assertEqual(outcome["status"], "incomplete")
        self.assertEqual(outcome["pendingToolIds"], ["search"])

    def test_result_and_events_survive_restart_and_new_turn(self):
        self.store.observe("session", Update(sessionUpdate="agent_message_chunk", content={"text": "结果"}))
        self.store.capture(self.record, {"completed": True})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "completed")
        restored = RunStateStore(self.directory.name)
        restored.begin("session", "next")
        snapshot = restored.snapshot("session", "turn", 0)
        self.assertEqual(snapshot["status"], "completed")
        self.assertEqual(snapshot["updates"][0]["content"]["text"], "结果")
        self.assertEqual(restored.snapshot("other", "turn")["status"], "unknown")
        self.assertEqual(restored.snapshot("session", "turn", 1)["updates"], [])

    def test_normal_stop_alone_does_not_prove_success(self):
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "incomplete")

    def test_terminal_is_immutable_and_cannot_clear_replacement_turn(self):
        self.store.capture(self.record, {"completed": True})
        completed = self.store.finish(self.record, "end_turn")
        replacement = self.store.begin("session", "replacement")
        self.store.capture(self.record, {"failed": True})
        self.assertEqual(self.store.finish(self.record, "cancelled", error=True), completed)
        self.assertIs(self.store.active["session"], replacement)

    def test_terminal_requires_durable_checkpoint_and_can_retry(self):
        self.store.capture(self.record, {"completed": True})
        with patch.object(self.store, "checkpoint", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.store.finish(self.record, "end_turn")
        self.assertEqual(self.record["status"], "running")
        self.assertIs(self.store.active["session"], self.record)
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "completed")

    def test_internal_continuation_can_reuse_turn_without_late_finish_mutation(self):
        self.store.observe("session", Update(sessionUpdate="agent_message_chunk", content={"text": "保留结果"}))
        self.store.capture(self.record, {"completed": True})
        completed = self.store.finish(self.record, "end_turn")
        continuation = self.store.begin("session", "turn")
        self.assertNotEqual(continuation["eventId"], completed["eventId"])
        self.assertEqual(self.store.finish(self.record, "cancelled"), completed)
        self.assertIs(self.store.active["session"], continuation)
        self.assertEqual(self.store.snapshot("session", "turn")["status"], "running")

    def test_runtime_failure_and_cancel_are_not_completed(self):
        self.store.capture(self.record, {"completed": True, "failed": True})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "failed")
        record = self.store.begin("session", "next")
        self.store.capture(record, {"completed": True, "interrupted": True})
        self.assertEqual(self.store.finish(record, "cancelled")["status"], "cancelled")

    def test_private_reasoning_is_not_in_replay(self):
        self.store.observe("session", Update(sessionUpdate="agent_thought_chunk", content={"text": "private"}))
        self.assertEqual(self.store.snapshot("session", "turn", 0)["updates"], [])

    def test_recovered_tool_failure_does_not_fail_a_completed_turn(self):
        self.store.observe("session", Update(sessionUpdate="tool_call", toolCallId="first", status="failed"))
        self.store.observe("session", Update(sessionUpdate="tool_call", toolCallId="retry", status="completed"))
        self.store.capture(self.record, {"completed": True, "failed": False})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "completed")


class RuntimeBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_entry_wrapper_captures_native_completion_and_exposes_status(self):
        import acp
        from acp_adapter.server import HermesACPAgent
        from baiqiu_run_state import ObservedConnection
        tree = ast.parse((Path(__file__).resolve().parents[1] / "services/baiqiu_acp_entry.py").read_text(encoding="utf-8"))
        definition = next(node for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == "BaiqiuACPAgent")
        agent = SimpleNamespace(tool_gen_callback=None, run_conversation=lambda **kwargs: {"completed": True})
        state = SimpleNamespace(agent=agent, cancel_event=None, history=[], is_running=False)
        async def idle(*args):
            return True
        namespace = dict(HermesACPAgent=HermesACPAgent, acp=acp, asyncio=asyncio, Path=Path,
                         os=os, logger=logging.getLogger(__name__), wait_for_session_idle=idle,
                         discard_interrupted_runtime_prompt=lambda *args: False,
                         make_tool_generation_callback=lambda *args: lambda *args: None,
                         bind_protocol_recovery=lambda *args, **kwargs: (SimpleNamespace(pending=False), lambda: None))
        for name in ("bind_provider_diagnostics", "bind_provider_timings", "bind_provider_usage", "bind_runtime_context"):
            namespace[name] = lambda *args: lambda: None
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "entry", "exec"), namespace)
        async def native_prompt(server, prompt, session_id, **kwargs):
            state.agent.run_conversation()
            await server._conn.session_update(session_id, acp.update_agent_message_text("完成正文"))
            return acp.schema.PromptResponse(stop_reason="end_turn")
        class Connection:
            async def session_update(self, *args, **kwargs):
                pass
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HERMES_HOME": directory}), \
             patch.object(HermesACPAgent, "prompt", native_prompt), \
             patch("baiqiu_async_delivery.bind_async_delivery", return_value=lambda success: None):
            server = namespace["BaiqiuACPAgent"](session_manager=SimpleNamespace(get_session=lambda key: state))
            server.on_connect(Connection())
            prompt = acp.text_block("test")
            prompt.field_meta = {"baiqiuTurnId": "turn"}
            response = await server.prompt([prompt], "session")
            self.assertEqual(response.field_meta["baiqiuRun"]["status"], "completed")
            replay = await server.ext_method("baiqiu/run_status", {"sessionId": "session", "turnId": "turn", "afterSequence": 0})
            self.assertEqual(replay["updates"][0]["content"]["text"], "完成正文")
            self.assertEqual(replay["updates"][0]["_meta"]["baiqiuRunEvent"]["turnId"], "turn")
            self.assertIsInstance(server._conn, ObservedConnection)
            continuation = await server.prompt([prompt], "session")
            self.assertEqual(continuation.field_meta["baiqiuRun"]["status"], "completed")
            self.assertNotEqual(continuation.field_meta["baiqiuRun"]["eventId"], response.field_meta["baiqiuRun"]["eventId"])


if __name__ == "__main__":
    unittest.main()
