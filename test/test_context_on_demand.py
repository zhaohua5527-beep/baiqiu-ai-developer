import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_tool_generation_bridge


class ContextOnDemandTest(unittest.TestCase):
    def test_image_wire_size_is_measured_without_removing_images_or_disclosing_them(self):
        bridge = test_tool_generation_bridge.ToolGenerationBridgeTest().load_bridge()
        body = {"messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,private-image"}},
            {"type": "text", "text": "private-question"}]}]}
        original = copy.deepcopy(body)
        metrics = bridge.context_request_profile(body)
        self.assertEqual(metrics['imageCount'], 1)
        self.assertEqual(metrics['imageDataChars'], len('data:image/jpeg;base64,private-image'))
        self.assertEqual(body, original)
        self.assertNotIn('private', json.dumps(metrics))

    def setUp(self):
        self.bridge = test_tool_generation_bridge.ToolGenerationBridgeTest().load_bridge()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.messages = [{"role": "system", "content": "keep maximum reasoning and all tools"}]
        for turn in range(5):
            self.messages.extend([
                {"role": "user", "content": f"request {turn}: keep my constraints"},
                {"role": "assistant", "content": "stage answer", "reasoning_content": "original reasoning",
                 "tool_calls": [{"id": f"call-{turn}", "type": "function", "function": {"name": "terminal", "arguments": '{"command":"read fixture"}'}}]},
                {"role": "tool", "tool_call_id": f"call-{turn}",
                 "content": json.dumps({"output": (f"evidence {turn}\n" * 3500) + "EXACT_END", "exit_code": 0})},
                {"role": "assistant", "content": f"permanent result {turn}"},
            ])
        self.messages.append({"role": "user", "content": "continue the second result"})

    def view(self, **kwargs):
        options = dict(mode="on", root=self.directory.name, session_id="session-A",
                       current_index=len(self.messages) - 1, readable=True, local=True)
        options.update(kwargs)
        return self.bridge.context_request_view(self.messages, **options)

    def test_shadow_changes_neither_history_nor_disk(self):
        before = copy.deepcopy(self.messages)
        result, metrics = self.view(mode="shadow")
        self.assertIs(result, self.messages)
        self.assertEqual(self.messages, before)
        self.assertEqual(metrics["contextCandidateCount"], 3)
        self.assertLess(metrics["contextCandidateChars"], metrics["contextBeforeChars"])
        self.assertEqual(metrics["contextSelectedChars"], metrics["contextBeforeChars"])
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_projection_preserves_all_user_answers_calls_and_protocol_fields(self):
        before = copy.deepcopy(self.messages)
        result, metrics = self.view()
        self.assertEqual(metrics["contextOffloadedCount"], 3)
        self.assertEqual(len(result), len(self.messages))
        for index, message in enumerate(self.messages):
            if message["role"] != "tool" or index >= 16:
                self.assertEqual(result[index], message)
            else:
                self.assertEqual(result[index]["tool_call_id"], message["tool_call_id"])
        self.assertEqual(result[13:], self.messages[13:])
        self.assertEqual(self.messages, before)
        for original, selected in zip(self.messages, result):
            if original != selected:
                target = selected["content"].split("Original result file: ", 1)[1].splitlines()[0]
                self.assertEqual(Path(target).read_bytes(), original["content"].encode("utf-8"))

    def test_corrupt_archive_is_repaired_and_restart_reuses_exact_reference(self):
        first, _ = self.view()
        archive = next(Path(self.directory.name).rglob("*.txt"))
        archive.write_text("corrupted", encoding="utf-8")
        second, _ = self.view()
        self.assertEqual(first, second)
        self.assertNotEqual(archive.read_text(encoding="utf-8"), "corrupted")
        self.assertEqual(len(list(Path(self.directory.name).rglob("*.txt"))), 3)
        other, _ = self.view(session_id="session-B")
        self.assertNotEqual(first[3]["content"], other[3]["content"])

    def test_windows_long_archive_path_does_not_grow_a_longer_temporary_name(self):
        preview = self.bridge.archive_context_output(self.directory.name, "A", "original")
        padding = 245 - len(preview) - 1
        root = Path(self.directory.name) / ("p" * max(1, padding))
        target = self.bridge.archive_context_output(root, "A", "original", write=True)
        self.assertEqual(Path(target).read_bytes(), b"original")
        self.assertEqual(list(root.rglob("*.tmp")), [])

    def test_current_turn_tool_results_are_kept_even_when_the_turn_grows(self):
        boundary = len(self.messages) - 1
        self.messages.extend(copy.deepcopy(self.messages[2:4]))
        self.messages[-2]["tool_calls"][0]["id"] = "active-call"
        self.messages[-1]["tool_call_id"] = "active-call"
        selected, metrics = self.view(current_index=boundary)
        self.assertEqual(metrics["contextOffloadedCount"], 3)
        self.assertEqual(selected[boundary:], self.messages[boundary:])

    def test_archive_write_failure_keeps_original_output(self):
        with patch.object(self.bridge, "archive_context_output", side_effect=OSError("disk full")):
            selected, metrics = self.view()
        self.assertIs(selected, self.messages)
        self.assertEqual(metrics["contextArchiveFailures"], 3)
        self.assertEqual(metrics["contextOffloadedCount"], 0)

    def test_query_matches_retain_full_evidence_including_middle_without_model_call(self):
        content = json.loads(self.messages[3]["content"])
        content["output"] = content["output"][:5000] + "SPECIFIC_REFERENCE 四川内江天气" + content["output"][5000:]
        self.messages[3]["content"] = json.dumps(content, ensure_ascii=False)
        for query in ("Find SPECIFIC_REFERENCE", "请查看四川内江天气"):
            with self.subTest(query=query):
                selected, metrics = self.view(query=query)
                self.assertEqual(selected[3], self.messages[3])
                self.assertEqual(metrics["contextRelevantCount"], 1)
                self.assertEqual(metrics["contextOffloadedCount"], 2)

    def test_unavailable_reader_remote_unknown_protocol_and_no_boundary_are_noops(self):
        for options in ({"readable": False}, {"local": False}, {"supported": False}, {"root": None},
                        {"session_id": ""}, {"current_index": -1}, {"mode": "off"}, {"mode": "invalid"}):
            with self.subTest(options=options):
                selected, metrics = self.view(**options)
                self.assertIs(selected, self.messages)
                self.assertEqual(metrics["contextOffloadedCount"], 0)

    def test_errors_skill_instructions_multimodal_and_missing_pairs_survive(self):
        for variant in ("error", "skill", "image", "missing", "unknown", "archive-read"):
            with self.subTest(variant=variant):
                modified = copy.deepcopy(self.messages)
                if variant == "error":
                    modified[3]["content"] = json.dumps({"output": "error" * 10000, "exit_code": 1})
                if variant == "skill":
                    modified[2]["tool_calls"][0]["function"]["arguments"] = '{"command":"cat AGENTS.md"}'
                if variant == "image":
                    modified[3]["content"] = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,test"}}]
                if variant == "missing":
                    modified[3]["tool_call_id"] = "missing"
                if variant == "unknown":
                    modified[2]["tool_calls"][0]["function"]["name"] = "memory"
                if variant == "archive-read":
                    modified[2]["tool_calls"][0]["function"]["arguments"] = '{"path":"context-evidence/example.txt"}'
                selected, _ = self.bridge.context_request_view(modified, mode="on", root=self.directory.name,
                    session_id="A", current_index=len(modified) - 1, readable=True)
                self.assertEqual(selected[3], modified[3])

    def test_live_binding_selects_only_request_view_and_restores_after_exception(self):
        history = copy.deepcopy(self.messages[:-1])
        current = "[Runtime context]\ncurrent rules\n[User request]\ncontinue"
        class Agent:
            session_id = "bound"
            api_mode = "chat_completions"
            provider = "deepseek"
            model = "deepseek-flash"
            base_url = "https://api.deepseek.com/v1"
            valid_tool_names = {"terminal", "read_file"}
            def _build_api_kwargs(self, messages):
                return {"messages": messages}
            def run_conversation(self, **kwargs):
                result = self._build_api_kwargs([*kwargs["conversation_history"], {"role": "user", "content": kwargs["user_message"]}])
                if kwargs.get("fail"):
                    raise RuntimeError("cancelled")
                return result
        agent = Agent()
        with patch.dict(os.environ, {"HERMES_HOME": self.directory.name, "BAIQIU_CONTEXT_POLICY": "on", "TERMINAL_ENV": "local"}):
            restore = self.bridge.bind_runtime_context(agent)
            result = agent.run_conversation(conversation_history=history, user_message=current)
            self.assertEqual(agent._baiqiu_context_metrics["contextOffloadedCount"], 3)
            self.assertIn("Original result file:", result["messages"][3]["content"])
            with self.assertRaises(RuntimeError):
                agent.run_conversation(conversation_history=history, user_message=current, fail=True)
            self.assertNotIn("_build_api_kwargs", agent.__dict__)
            restore()
        self.assertEqual(history, self.messages[:-1])

    def test_only_isolation_tested_routes_can_opt_into_selection(self):
        from types import SimpleNamespace
        routes = [
            ("deepseek", "https://api.deepseek.com/v1", "deepseek-flash", True),
            ("deepseek", "https://api.deepseek.com/v1", "deepseek-v4-flash", True),
            ("zai", "https://open.bigmodel.cn/api/paas/v4", "glm-5.3-flash", True),
            ("deepseek", "https://api.deepseek.com.invalid/v1", "deepseek-flash", False),
            ("deepseek", "https://api.deepseek.com/v1", "unknown-model", False),
            ("anthropic", "https://api.anthropic.com/v1", "any", False),
        ]
        for provider, base_url, model, supported in routes:
            with self.subTest(provider=provider, base_url=base_url, model=model):
                agent = SimpleNamespace(provider=provider, base_url=base_url, model=model, api_mode="chat_completions")
                self.assertEqual(self.bridge.context_protocol_supported(agent), supported)

    def test_diagnostics_only_contain_numeric_sizes(self):
        body = {"messages": [{"role": "user", "content": "private-key"},
                              {"role": "assistant", "reasoning_content": "private-reasoning"}],
                "tools": [{"description": "private-tool"}], "api_key": "private-secret"}
        profile = self.bridge.context_request_profile(body)
        self.assertTrue(all(isinstance(value, int) for value in profile.values()))
        self.assertNotIn("private", json.dumps(profile))
        self.assertGreater(profile["protocolReplayChars"], 0)
        self.assertEqual(self.bridge.context_request_profile({"messages": [{"role": "user", "content": object()}]})["userChars"], 0)


if __name__ == "__main__":
    unittest.main()
