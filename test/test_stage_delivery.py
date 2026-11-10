import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_stage_delivery import StageDelivery, bind_stage_delivery, progress_payloads
from baiqiu_protocol_recovery import install_protocol_recovery


def envelope(kind="stage_result", **fields):
    return "<baiqiu-progress>" + json.dumps({"type": kind, "segmentId": "part-1",
        "goalId": "part-1", "message": "已核实 A 表合计 120 元。", "evidenceToolCallIds": ["read-1"], **fields}, ensure_ascii=False) + "</baiqiu-progress>"


def response(content="", tools=None):
    return SimpleNamespace(content=content, tool_calls=tools, finish_reason="tool_calls" if tools else "stop",
        reasoning=None, reasoning_content=None, reasoning_details=None, codex_reasoning_items=None,
        codex_message_items=None, role="assistant")


class StageDeliveryTest(unittest.TestCase):
    def test_checkpoint_is_request_only_and_no_tool_means_no_reminder(self):
        events = []
        delivery = StageDelivery(events.append)
        messages = [{"role": "user", "content": "原始目标"}]
        self.assertIs(delivery.prepare(messages), messages)
        messages.append({"role": "tool", "tool_call_id": "read-1", "content": "120"})
        original = copy.deepcopy(messages)
        prepared = delivery.prepare(messages)
        self.assertEqual(messages, original)
        self.assertEqual(prepared[:-1], original)
        self.assertIn("read-1", prepared[-1]["content"])
        delivery.prepare(messages)
        self.assertEqual(len(events), 1)

    def test_ready_without_delivery_is_reminded_and_cross_does_not_clear_it(self):
        events = []
        delivery = StageDelivery(events.append)
        messages = [{"role": "tool", "tool_call_id": "read-1", "content": "120"}]
        action = envelope("action", stageAssessment={"state": "ready", "goalId": "part-1", "evidenceToolCallIds": ["read-1"]})
        delivery.observe(response(action, ["next"]), messages)
        self.assertEqual(events[-1]["stage"], "delivery_missing")
        delivery.observe(response(envelope("cross"), ["next"]), messages)
        self.assertIn("part-1", delivery.pending)
        self.assertIn("part-1", delivery.prepare(messages)[-1]["content"])
        delivery.observe(response(envelope(), ["next"]), messages)
        self.assertFalse(delivery.pending)
        self.assertIs(delivery.prepare(messages), messages)
        authored = [event for event in events if event["stage"] == "authored"]
        self.assertTrue(authored[0]["evidenceResolved"])
        delivery.observe(response(envelope(), ["next"]), messages)
        self.assertEqual(len([event for event in events if event["stage"] == "authored"]), 2)

    def test_missing_assessment_is_unknown_not_fabricated_no_result(self):
        events = []
        delivery = StageDelivery(events.append)
        messages = [{"role": "tool", "tool_call_id": "read-1", "content": "not found"}]
        delivery.observe(response("", ["next"]), messages)
        self.assertEqual(events[-1]["stage"], "assessment_missing")
        delivery.observe(response(envelope("action", stageAssessment={"state": "pending", "goalId": "part-1", "evidenceToolCallIds": ["read-1"]}), ["next"]), messages)
        self.assertEqual(events[-1]["stage"], "pending")
        self.assertIs(delivery.prepare(messages), messages)
        self.assertFalse(any(event["stage"] == "authored" for event in events))

    def test_final_answer_is_allowed_without_forced_stage(self):
        events = []
        delivery = StageDelivery(events.append)
        delivery.observe(response("答案是 120。"), [{"role": "tool", "tool_call_id": "read-1", "content": "120"}])
        self.assertEqual([event["stage"] for event in events], ["final"])

    def test_invalid_evidence_is_not_counted_as_resolved_and_cancellation_is_quiet(self):
        events = []
        delivery = StageDelivery(events.append, history=[{"role": "tool", "tool_call_id": "old"}])
        delivery.observe(response(envelope(evidenceToolCallIds=["old"])), [])
        self.assertFalse(next(event for event in events if event["stage"] == "authored")["evidenceResolved"])
        self.assertFalse(delivery.assessed)
        delivery.cancelled = lambda: True
        before = len(events)
        messages = [{"role": "tool", "tool_call_id": "new"}]
        self.assertIs(delivery.prepare(messages), messages)
        delivery.observe(response(envelope()), messages)
        self.assertEqual(len(events), before)

    def test_fenced_examples_and_malformed_tags_are_not_authored_results(self):
        self.assertFalse(progress_payloads("```xml\n" + envelope() + "\n```"))
        self.assertFalse(progress_payloads(envelope().replace("</baiqiu-progress>", "")))

    def test_audit_length_matches_javascript_and_cross_cannot_assess_delivery(self):
        events = []
        delivery = StageDelivery(events.append)
        messages = [{"role": "tool", "tool_call_id": "read-1", "content": "120"}]
        delivery.observe(response(envelope("cross", stageAssessment={"state": "pending", "goalId": "part-1", "evidenceToolCallIds": ["read-1"]}), ["next"]), messages)
        self.assertFalse(delivery.assessed)
        delivery.observe(response(envelope(message="核实🙂")), messages)
        self.assertEqual(next(event for event in events if event["stage"] == "authored")["contentChars"], 4)

    def test_native_loop_inspects_before_next_tool_without_extra_model_calls(self):
        from run_agent import AIAgent
        install_protocol_recovery()
        tools = [{"type": "function", "function": {"name": "terminal", "description": "isolated reader",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}]
        with patch("run_agent.get_tool_definitions", return_value=tools), patch("run_agent.check_toolset_requirements", return_value={}), patch("run_agent.OpenAI"):
            agent = AIAgent(api_key="isolated-test", base_url="https://example.invalid/v1", model="test-model",
                quiet_mode=True, skip_context_files=True, skip_memory=True)
        agent.client = MagicMock()
        agent._cached_system_prompt = "Follow the public progress protocol."
        agent._use_prompt_caching = False
        agent.tool_delay = 0
        agent.compression_enabled = False
        agent.save_trajectories = False
        call = lambda ident: SimpleNamespace(id=ident, type="function", function=SimpleNamespace(name="terminal", arguments='{"command":"read fixture"}'))
        responses = [response("", [call("read-1")]), response(envelope(), [call("read-2")]), response("最终答案")]
        agent.client.chat.completions.create.side_effect = [SimpleNamespace(id="test", model="test-model",
            choices=[SimpleNamespace(index=0, message=item, finish_reason=item.finish_reason)], usage=None) for item in responses]
        events = []
        with patch("acp_adapter.events._send_update", side_effect=lambda conn, sid, loop, update: events.append(update.field_meta["baiqiu_diagnostic"])):
            delivery, restore = bind_stage_delivery(agent, None, "session", None, lambda: False, "turn")
            with patch.object(agent, "_persist_session"), patch.object(agent, "_flush_messages_to_session_db"), patch.object(agent, "_save_trajectory"), patch.object(agent, "_cleanup_task_resources"), patch("run_agent.handle_function_call", return_value='{"output":"120","exit_code":0}') as execute:
                result = agent.run_conversation("读两份文件，第一份结束先交付，再读下一份")
            restore()
        self.assertTrue(result["completed"])
        self.assertEqual(execute.call_count, 2)
        requests = agent.client.chat.completions.create.call_args_list
        self.assertEqual(len(requests), 3)
        self.assertNotIn("Runtime stage delivery checkpoint", str(requests[0]))
        self.assertIn("Runtime stage delivery checkpoint", str(requests[1]))
        self.assertTrue(any(event["stage"] == "authored" and event["evidenceResolved"] for event in events))
        self.assertFalse(any("Runtime stage delivery checkpoint" in str(message.get("content")) for message in result["messages"]))
        self.assertFalse(hasattr(agent, "_baiqiu_stage_delivery"))


if __name__ == "__main__":
    unittest.main()
