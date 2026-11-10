import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_run_state import RunStateStore
from baiqiu_stage_delivery import StageDelivery
from baiqiu_supplements import TurnSupplements, bind_supplements
from test_supplements import NativeAgent


class ContinuationContractTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = RunStateStore(self.directory.name)
        self.record = self.store.begin("session", "turn")
        self.agent = NativeAgent()
        self.events = []
        self.channel = TurnSupplements(self.agent, self.record, self.events.append, lambda: False, self.store.checkpoint)
        self.delivery = StageDelivery(self.events.append, turn_id="turn")
        self.delivery.supplements = self.channel

    def applied(self):
        self.channel.receive("supplement", "改成三项，不要重复之前的操作")
        self.channel.observe_request([{"role": "user", "content": self.agent.received[0]}])

    def test_acceptance_survives_process_replacement_without_redelivery(self):
        self.channel.receive("supplement", "保留补充")
        snapshot = RunStateStore(self.directory.name).snapshot("session", "turn")
        self.assertEqual(snapshot["supplements"]["supplement"]["status"], "accepted")
        self.channel.receive("supplement", "保留补充")
        self.assertEqual(len(self.agent.received), 1)

    def test_tool_boundary_delivers_real_user_input_without_stopping_tools(self):
        self.agent._executing_tools = True
        restore = bind_supplements(self.agent, self.channel)
        self.addCleanup(restore)
        self.channel.receive("supplement", "保留文件")
        self.assertEqual(self.agent.received, [])
        native_input = self.agent._drain_pending_redirect()
        self.channel.observe_request([{"role": "tool", "content": native_input}])
        self.assertEqual(self.record["supplements"]["supplement"]["status"], "accepted")
        self.agent._build_api_kwargs([{"role": "user", "content": native_input}])
        self.assertEqual(self.record["supplements"]["supplement"]["status"], "applied")
        self.assertIsNone(self.agent._drain_pending_redirect())

    def test_redirect_race_does_not_insert_supplement_into_tool_output(self):
        steered = []
        self.agent.steer = lambda text: steered.append(text) or True

        def redirect(text):
            self.agent._executing_tools = True
            return self.agent.steer(text)

        self.agent.redirect = redirect
        restore = bind_supplements(self.agent, self.channel)
        self.addCleanup(restore)
        self.channel.receive("supplement", "工具完成后接续")
        self.assertEqual(steered, [])
        native_input = self.agent._drain_pending_redirect()
        self.assertIn("工具完成后接续", native_input)
        self.agent._build_api_kwargs([{"role": "user", "content": native_input}])
        self.assertEqual(self.record["supplements"]["supplement"]["status"], "applied")
        self.agent.steer("unrelated native steer")
        self.assertEqual(steered, ["unrelated native steer"])

    def test_durability_failure_precedes_native_side_effects(self):
        def fail(record):
            raise OSError("disk unavailable")
        self.channel.checkpoint = fail
        with self.assertRaises(OSError):
            self.channel.receive("supplement", "不要丢失")
        self.assertFalse(self.agent.received)
        self.assertFalse(self.record["supplements"])

    def test_request_inclusion_alone_cannot_complete_a_supplement(self):
        self.applied()
        self.channel.finish_or_continue({"completed": True})
        self.store.capture(self.record, {"completed": True})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "incomplete")

    def test_normal_answer_resolves_supplement_without_a_stage_card(self):
        self.applied()
        body = "知道，我会改成三项，并保留已经完成的结果。"
        metadata = {"status": "completed", "kind": "inline_text", "supplementResolutions": [
            {"supplementId": "supplement", "status": "addressed"}],
            "taskCompletion": {"status": "completed", "scope": "active_task",
                "turnId": "turn", "supplementIds": ["supplement"]}}
        response = SimpleNamespace(content=body + "\n<baiqiu-outcome>" + json.dumps(metadata) + "</baiqiu-outcome>", tool_calls=[])
        self.delivery.observe(response, [])
        self.assertEqual(self.record["supplements"]["supplement"]["status"], "addressed")
        self.assertEqual(self.delivery.terminal_delivery["outputs"][0]["sha256"], hashlib.sha256(body.encode()).hexdigest())
        self.assertEqual(self.delivery.terminal_delivery["outputs"][0]["target"], "answer")
        self.record["completion"] = self.delivery.terminal_delivery
        self.channel.finish_or_continue({"completed": True})
        self.store.capture(self.record, {"completed": True})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "completed")

    def test_supplement_is_not_a_replacement_user_request(self):
        self.channel.receive("supplement", "原任务中再考虑预算")
        native_input = self.agent.received[0]
        self.assertIn("[Active task supplement]", native_input)
        self.assertNotIn("[User request]", native_input)
        self.assertIn("原任务中再考虑预算", native_input)

    def test_answering_supplement_alone_cannot_complete_the_original_task(self):
        self.applied()
        metadata = {"status": "completed", "kind": "inline_text", "supplementResolutions": [
            {"supplementId": "supplement", "status": "addressed"}]}
        self.delivery.observe(SimpleNamespace(content="已回答补充，但原任务尚未交付。\n<baiqiu-outcome>"
            + json.dumps(metadata) + "</baiqiu-outcome>", tool_calls=[]), [])
        self.assertEqual(self.record["supplements"]["supplement"]["status"], "addressed")
        self.assertIsNone(self.delivery.terminal_delivery)
        self.channel.finish_or_continue({"completed": True})
        self.store.capture(self.record, {"completed": True})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "incomplete")

    def test_whole_task_scope_requires_current_turn_and_all_supplements(self):
        self.applied()
        declaration = {"status": "completed", "scope": "active_task", "turnId": "other",
            "supplementIds": ["supplement"]}
        self.assertFalse(self.delivery.covers_active_task(declaration))
        declaration["turnId"] = "turn"
        self.assertTrue(self.delivery.covers_active_task(declaration))
        self.channel.receive("second", "再限制范围")
        self.assertFalse(self.delivery.covers_active_task(declaration))
        declaration["supplementIds"] = ["supplement", "second"]
        self.assertTrue(self.delivery.covers_active_task(declaration))
        declaration["supplementIds"] = ["supplement", "second", "second"]
        self.assertFalse(self.delivery.covers_active_task(declaration))

    def test_clarification_is_waiting_not_completed_or_failed(self):
        self.applied()
        metadata = {"status": "awaiting_input", "kind": "inline_text", "supplementResolutions": [
            {"supplementId": "supplement", "status": "needs_clarification"}]}
        self.delivery.observe(SimpleNamespace(content="需要保留哪三项？\n<baiqiu-outcome>" + json.dumps(metadata)
            + "</baiqiu-outcome>", tool_calls=[]), [])
        self.channel.finish_or_continue({"completed": True})
        self.record["completion"] = self.delivery.terminal_delivery
        self.store.capture(self.record, {"completed": True})
        self.assertEqual(self.store.finish(self.record, "end_turn")["status"], "awaiting_input")

    def test_stage_status_does_not_replace_explicit_task_completion(self):
        metadata = {"schemaVersion": 2, "type": "stage_result", "segmentId": "one", "status": "completed"}
        def response():
            return SimpleNamespace(content="<baiqiu-progress>" + json.dumps(metadata) + "\n阶段正文\n</baiqiu-progress>", tool_calls=[])
        self.delivery.supplements = None
        self.delivery.observe(response(), [])
        self.assertIsNone(self.delivery.terminal_delivery)
        metadata["taskCompletion"] = {"status": "completed", "deliveredSegmentIds": ["missing"]}
        self.delivery.observe(response(), [])
        self.assertIsNone(self.delivery.terminal_delivery)
        metadata["taskCompletion"]["deliveredSegmentIds"] = ["one"]
        self.delivery.observe(response(), [])
        self.assertEqual(self.delivery.terminal_delivery["outputs"][0]["segmentId"], "one")


if __name__ == "__main__":
    unittest.main()
