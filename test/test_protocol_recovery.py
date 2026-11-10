import copy
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_protocol_recovery import (ProtocolRecovery, protocol_fault, install_protocol_recovery,
    completed_tools, progress_only_without_answer)
from baiqiu_stage_delivery import progress_payloads

BROKEN = '<baiqiu-progress>{"type":"stage_result","segmentId":"4","message":"第二轮已完成，继续定位。"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
BOUNDED_INVALID = '<baiqiu-progress>{"type":"stage_result","segmentId":"1","message":"已核对"依据"。"}</baiqiu-progress>'


def response(text, calls=None):
    return SimpleNamespace(content=text, tool_calls=calls, finish_reason="stop", reasoning=None,
        reasoning_content=None, reasoning_details=None, codex_reasoning_items=None,
        codex_message_items=None, role="assistant")


class ProtocolRecoveryTest(unittest.TestCase):
    def test_markdown_body_is_not_json_and_code_examples_are_not_protocol(self):
        body = '# 结果\n\n已核对 "依据"，路径 C:\\reports\\file。\n\n```xml\n</baiqiu-progress>\n<baiqiu-answer>示例</baiqiu-answer>\n```\n\n| 项目 | 数值 |\n|---|---|\n| 库存 | 20% |'
        content = '<baiqiu-progress>{"schemaVersion":2,"segmentId":"1","type":"stage_result"}\n' + body + '\n</baiqiu-progress>'
        self.assertEqual(progress_payloads(content)[0]['message'], body)
        self.assertEqual(protocol_fault(content), '')
        self.assertTrue(protocol_fault(content[:-20]))

    def test_bounded_progress_failure_with_final_answer_is_warning_not_retry(self):
        events = []
        recovery = ProtocolRecovery(events.append)
        agent = SimpleNamespace()
        self.assertEqual(recovery.inspect(agent, response(BOUNDED_INVALID + '\n完整的最终正文。'), [], []), '')
        self.assertEqual(recovery.attempts, 0)
        self.assertEqual(events[0]['phase'], 'warning')
        self.assertFalse(recovery.pending)

    def test_progress_only_terminal_response_recovers_missing_public_answer(self):
        events = []
        recovery = ProtocolRecovery(events.append)
        agent = SimpleNamespace(_build_assistant_message=lambda value, finish: {
            "role": "assistant", "content": value.content},
            _flush_messages_to_session_db=lambda messages, previous: None,
            _emit_interim_assistant_message=lambda message: None,
            _baiqiu_stage_delivery=SimpleNamespace(terminal_delivery=None))
        content = '<baiqiu-progress>{"schemaVersion":2,"segmentId":"1","type":"stage_result","stage":"execute","status":"completed"}\n已完成阶段交付。\n</baiqiu-progress>'
        self.assertTrue(progress_only_without_answer(content))
        self.assertEqual(recovery.inspect(agent, response(content), [], []), "retry")
        self.assertEqual(events[-1]["reason"], "missing_public_answer")

    def test_completed_stage_delivery_does_not_trigger_missing_answer_recovery(self):
        events = []
        recovery = ProtocolRecovery(events.append)
        agent = SimpleNamespace(_baiqiu_stage_delivery=SimpleNamespace(terminal_delivery={"status": "completed"}))
        content = '<baiqiu-progress>{"schemaVersion":2,"segmentId":"1","type":"stage_result","stage":"execute","status":"completed"}\n已完成全部交付。\n</baiqiu-progress>'
        self.assertEqual(recovery.inspect(agent, response(content), [], []), "")
        self.assertEqual(events, [])

    def test_warning_cannot_hide_unsettled_tools_or_truncated_answers(self):
        content = BOUNDED_INVALID + '\n已有正文。'
        for finish, history in (("length", []), ("stop", [{"role": "assistant", "tool_calls": [
                {"id": "pending", "function": {"name": "write_file", "arguments": '{}'}}]}])):
            events = []
            recovery = ProtocolRecovery(events.append)
            agent = SimpleNamespace(_build_assistant_message=lambda value, reason: {"role": "assistant", "content": value.content},
                _flush_messages_to_session_db=lambda messages, previous: None, _emit_interim_assistant_message=lambda message: None)
            value = response(content)
            value.finish_reason = finish
            self.assertIn(recovery.inspect(agent, value, history, [], 0), ("retry", "failed"))
            self.assertNotIn("warning", [event['phase'] for event in events])

    def test_detection_is_protocol_based_not_a_prose_completion_guess(self):
        self.assertEqual(protocol_fault(BROKEN), "unclosed_progress")
        for text in ("继续再看看。", "已完成。", "```xml\n" + BROKEN + "\n```", "`" + BROKEN.splitlines()[0] + "`"):
            self.assertFalse(protocol_fault(text))
        self.assertEqual(protocol_fault('<baiqiu-progress>{"message":"半句'), "invalid_progress_json")

    def test_retry_budget_persistence_cancel_and_no_tool_replay(self):
        events, persisted = [], []
        recovery = ProtocolRecovery(events.append)
        agent = SimpleNamespace(_build_assistant_message=lambda value, finish: {"role": "assistant", "content": value.content},
            _flush_messages_to_session_db=lambda messages, history: persisted.append(copy.deepcopy(messages)),
            _emit_interim_assistant_message=lambda message: None)
        messages = [{"role": "user", "content": "原始任务"}]
        recovery.inspect(agent, response("开始", ["call"]), messages, [])
        messages.extend([{"role": "assistant", "tool_calls": [{"id": "write-1", "function": {"name": "write_file", "arguments": '{"path":"test.txt","content":"done"}'}}]},
            {"role": "tool", "tool_call_id": "write-1", "content": '{"success":true}'}])
        self.assertEqual(recovery.inspect(agent, response(BROKEN), messages, []), "retry")
        self.assertEqual(persisted[-1][-1]["content"], BROKEN)
        self.assertEqual(recovery.reuse("write_file", {"content": "done", "path": "test.txt"}), (True, '{"success":true}', False))
        self.assertEqual(recovery.inspect(agent, response("正常结果"), messages, []), "")
        self.assertEqual(recovery.inspect(agent, response(BROKEN), messages, []), "retry")
        self.assertEqual(recovery.inspect(agent, response(BROKEN), messages, []), "failed")
        self.assertEqual(recovery.attempts, 2)
        self.assertEqual([event["phase"] for event in events], ["retrying", "recovered", "retrying", "failed"])
        agent._interrupt_requested = True
        self.assertEqual(recovery.inspect(agent, response(BROKEN), messages, []), "cancelled")
        self.assertEqual(len(events), 4)

    def test_failed_persistence_does_not_start_recovery(self):
        events = []
        recovery = ProtocolRecovery(events.append)
        agent = SimpleNamespace(_build_assistant_message=lambda value, finish: {"role": "assistant", "content": value.content},
            _flush_messages_to_session_db=MagicMock(side_effect=OSError("disk full")))
        with self.assertRaises(OSError):
            recovery.inspect(agent, response(BROKEN), [], [])
        self.assertFalse(events)
        self.assertTrue(recovery.pending)
        agent._flush_messages_to_session_db = lambda messages, history: False
        agent._emit_interim_assistant_message = lambda message: None
        self.assertEqual(recovery.inspect(agent, response(BROKEN), [], []), "failed")
        self.assertEqual(events[-1]["reason"], "checkpoint_persistence_failed")
        self.assertNotIn("retrying", [event["phase"] for event in events])

    def test_same_turn_restores_retry_budget_and_completed_effects(self):
        events = []
        history = [{"role": "user", "content": "task"},
            {"role": "assistant", "tool_calls": [{"id": "done", "function": {
                "name": "write_file", "arguments": '{"path":"result.txt"}'}}]},
            {"role": "tool", "tool_call_id": "done", "content": "saved"}]
        agent = SimpleNamespace(_build_assistant_message=lambda value, finish: {
            "role": "assistant", "content": value.content, "tool_calls": None},
            _flush_messages_to_session_db=lambda messages, previous: None,
            _emit_interim_assistant_message=lambda message: None)
        recovery = ProtocolRecovery(events.append, turn_id="turn-one")
        self.assertEqual(recovery.inspect(agent, response(BROKEN), history, [], 1), "retry")
        self.assertEqual(recovery.inspect(agent, response(BROKEN), history, [], 1), "retry")
        from hermes_state import SessionDB
        with tempfile.TemporaryDirectory() as directory:
            database = SessionDB(Path(directory) / "state.db")
            database.create_session("session-one", "test")
            for message in history:
                if not message.get("_pre_verify_synthetic"):
                    database.append_message("session-one", **message)
            database.close()
            database = SessionDB(Path(directory) / "state.db")
            restored_history = database.get_messages_as_conversation("session-one")
            database.close()
        restored = ProtocolRecovery(events.append, turn_id="turn-one", history=restored_history)
        self.assertEqual(restored.attempts, 2)
        self.assertEqual(restored.reuse("write_file", {"path": "result.txt"}), (True, "saved", False))
        self.assertEqual(restored.inspect(agent, response(BROKEN), history, [], len(history)), "failed")
        fresh = ProtocolRecovery(events.append, turn_id="turn-two", history=history)
        self.assertEqual(fresh.attempts, 0)
        self.assertEqual(fresh.reuse("write_file", {"path": "result.txt"}), (False, None, False))
        for checkpoint in (None, "bad", {"turnId": "turn-one", "attempts": "bad", "toolIds": [None, {}]}):
            ProtocolRecovery(events.append, turn_id="turn-one", history=[{
                "display_metadata": {"baiqiuProtocolRecovery": checkpoint}}])

    def test_acp_prompt_metadata_preserves_turn_identity(self):
        from acp.schema import TextContentBlock
        block = TextContentBlock.model_validate({"type": "text", "text": "task", "_meta": {"baiqiuTurnId": "turn-one"}})
        self.assertEqual(block.field_meta["baiqiuTurnId"], "turn-one")

    def test_uncertain_or_running_tools_cannot_be_replayed(self):
        messages = [{"role": "assistant", "tool_calls": [{"id": "one", "function": {
            "name": "terminal", "arguments": '{"command":"publish"}'}}]}]
        self.assertTrue(completed_tools(messages)[2])
        messages.append({"role": "tool", "tool_call_id": "one", "content": "timeout", "effect_disposition": "unknown"})
        results, uncertain, unsettled = completed_tools(messages)
        self.assertFalse(unsettled)
        self.assertFalse(results)
        recovery = ProtocolRecovery(lambda event: None)
        recovery.uncertain = uncertain
        found, result, blocked = recovery.reuse("terminal", {"command": "publish"})
        self.assertTrue(found and blocked)
        self.assertIn("execution_state_unknown", result)

    def test_real_native_loop_recovers_and_remains_bounded(self):
        from run_agent import AIAgent
        install_protocol_recovery()
        tool = lambda ident: SimpleNamespace(id=ident, type="function", function=SimpleNamespace(name="terminal", arguments='{"command":"echo isolated-effect"}'))
        cases = (([response(BROKEN), response("任务已完成，真实结果在这里。")], 2, True, 0),
            ([response(BROKEN)] * 3, 3, False, 0), ([response("你好！")], 1, True, 0),
            ([response("开始", [tool("one")]), response(BROKEN), response("继续", [tool("two")]), response("任务完成。")], 4, True, 1),
            ([response(BOUNDED_INVALID, [tool("one")]), response("已交付正文，请补充资料。")], 2, True, 1),
            ([response(BOUNDED_INVALID + '\n完整正文。')], 1, True, 0),
            ([response('<baiqiu-progress>{"schemaVersion":2,"segmentId":"1","type":"stage_result"}\n已核对 "依据"。\n</baiqiu-progress>\n完整正文。')], 1, True, 0),
            ([response(BOUNDED_INVALID)] * 3, 3, False, 0))
        definitions = [{"type": "function", "function": {"name": "terminal", "description": "isolated tool", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}]
        for responses, expected_calls, completed, effects in cases:
            with patch("run_agent.get_tool_definitions", return_value=definitions), patch("run_agent.check_toolset_requirements", return_value={}), patch("run_agent.OpenAI"):
                agent = AIAgent(api_key="isolated-test", base_url="https://example.invalid/v1", model="test-model",
                    quiet_mode=True, skip_context_files=True, skip_memory=True)
            agent.client = MagicMock()
            agent._cached_system_prompt = "You are helpful."
            agent._use_prompt_caching = False
            agent.tool_delay = 0
            agent.compression_enabled = False
            agent.save_trajectories = False
            agent.client.chat.completions.create.side_effect = [SimpleNamespace(id="test", model="test-model",
                choices=[SimpleNamespace(index=0, message=item, finish_reason="tool_calls" if item.tool_calls else "stop")], usage=None) for item in responses]
            events = []
            agent._baiqiu_protocol_recovery = ProtocolRecovery(events.append)
            with patch.object(agent, "_persist_session"), patch.object(agent, "_flush_messages_to_session_db"), patch.object(agent, "_save_trajectory"), patch.object(agent, "_cleanup_task_resources"), patch("run_agent.handle_function_call", return_value='{"output":"isolated-effect","exit_code":0}') as execute:
                result = agent.run_conversation("定位工程并完成任务")
            self.assertEqual(agent.client.chat.completions.create.call_count, expected_calls)
            self.assertEqual(execute.call_count, effects)
            self.assertEqual(result["completed"], completed)
            if completed:
                self.assertEqual(result["final_response"], responses[-1].content)


if __name__ == "__main__":
    unittest.main()
