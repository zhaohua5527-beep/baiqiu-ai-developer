import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))

from baiqiu_tool_execution import install_tool_execution, replace_once, split_git_diagnostics
from agent import tool_executor
from acp_adapter import events
from tools import file_operations, file_tools


class ToolExecutionProgressTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_tool_execution()

    def test_search_start_retains_public_arguments_for_distinct_parallel_searches(self):
        from acp_adapter import tools as acp_tools
        updates = [acp_tools.build_tool_start("call-" + pattern, "search_files", {
            "pattern": pattern, "path": "D:/fixture", "target": "content", "api_key": "not-public"
        }).model_dump(by_alias=True, exclude_none=True) for pattern in ("撤销", "中止")]
        self.assertEqual([update["rawInput"]["pattern"] for update in updates], ["撤销", "中止"])
        self.assertTrue(all(update["rawInput"]["path"] == "D:/fixture" for update in updates))
        self.assertTrue(all("api_key" not in update["rawInput"] for update in updates))
        self.assertNotEqual(updates[0]["toolCallId"], updates[1]["toolCallId"])

    def setUp(self):
        self.updates = []
        self.persisted = []
        self.queues = {}
        self.metadata = {}
        self.sender = patch.object(events, "_send_update", side_effect=lambda *args: self.updates.append(args[-1]))
        self.sender.start()
        self.addCleanup(self.sender.stop)
        self.callback = events.make_tool_progress_cb(None, "isolated", None, self.queues, self.metadata)

    def agent(self):
        return SimpleNamespace(
            _interrupt_requested=False, quiet_mode=True, verbose_logging=False,
            _tool_worker_threads=set(), _tool_worker_threads_lock=threading.Lock(),
            _should_emit_quiet_tool_messages=lambda: False,
            _should_start_quiet_spinner=lambda: False,
            _touch_activity=lambda *args: None,
            _append_guardrail_observation=lambda name, args, result, **kwargs: result,
            _record_file_mutation_result=lambda *args: None,
            _subdirectory_hints=SimpleNamespace(check_tool_call=lambda *args: ""),
            _tool_result_content_for_active_model=lambda name, result: result,
            _flush_messages_to_session_db=lambda messages: self.persisted.append(copy.deepcopy(messages)),
            tool_progress_callback=self.callback, tool_start_callback=None, tool_complete_callback=None,
            _apply_pending_steer_to_tool_results=lambda *args: None,
            _vprint=lambda *args, **kwargs: None,
            log_prefix="", session_id="isolated", _current_tool=None, _context_engine_tool_names=set(), _memory_manager=None,
        )

    def run_batch(self, agent, tools, messages):
        def middleware(current, **kwargs):
            def begin():
                current.tool_progress_callback("tool.started", kwargs["function_name"], None,
                                               kwargs["function_args"], tool_call_id=kwargs["tool_call_id"])
            kwargs["begin_execution"](begin)
            result = kwargs["execute"](kwargs["function_args"])
            return SimpleNamespace(result=result, args=kwargs["function_args"], middleware_trace=[], blocked=False)

        with patch.object(tool_executor, "_run_agent_tool_execution_middleware", side_effect=middleware), \
             patch.object(tool_executor, "_ra", return_value=SimpleNamespace(_set_interrupt=lambda *args: None)), \
             patch.object(tool_executor, "get_active_env", return_value=None), \
             patch.object(tool_executor, "_resolve_concurrent_tool_timeout", return_value=getattr(agent, "test_timeout", 3)):
            tool_executor.execute_tool_calls_concurrent(agent, SimpleNamespace(tool_calls=tools), messages, "isolated")

    def calls(self):
        return [SimpleNamespace(id=name, function=SimpleNamespace(name="search_files", arguments=json.dumps({"pattern": name})))
                for name in ("slow", "fast")]

    def test_fast_same_name_result_is_durable_and_visible_before_slow_finishes(self):
        agent = self.agent()
        release = threading.Event()
        fast = threading.Event()
        errors = []
        messages = [{"role": "assistant", "content": "已交付的阶段结果"}]

        def invoke(name, arguments, task, call_id, **kwargs):
            if call_id == "slow":
                release.wait(3)
            return json.dumps({"files": [call_id + ".txt"]})

        agent._invoke_tool = invoke
        def send(*args):
            update = args[-1]
            self.updates.append(update)
            if getattr(update, "status", None) == "completed":
                if self.persisted[-1][-1].get("tool_call_id") == "fast":
                    fast.set()
        def run():
            try:
                self.run_batch(agent, self.calls(), messages)
            except BaseException as error:
                errors.append(error)

        with patch.object(events, "_send_update", side_effect=send):
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.assertTrue(fast.wait(2), errors)
                self.assertTrue(worker.is_alive())
                self.assertEqual(self.persisted[-1][-1]["tool_call_id"], "fast")
                starts = [update for update in self.updates if update.session_update == "tool_call"]
                finished = [update for update in self.updates if getattr(update, "status", None) == "completed"]
                self.assertEqual(len(finished), 1)
                self.assertEqual(finished[0].tool_call_id, starts[1].tool_call_id)
            finally:
                release.set()
                worker.join(4)
        self.assertFalse(errors)
        self.assertEqual([message.get("tool_call_id") for message in messages[1:]], ["slow", "fast"])
        self.assertEqual(messages[0]["content"], "已交付的阶段结果")
        self.assertFalse(self.queues)
        before = len(self.updates)
        events.make_step_cb(None, "isolated", None, self.queues, self.metadata)(1, [
            {"name": "search_files", "result": "slow"}, {"name": "search_files", "result": "fast"}])
        self.assertEqual(len(self.updates), before)

    def test_timeout_preserves_fast_result_and_does_not_publish_late_worker(self):
        agent = self.agent()
        agent.test_timeout = 0.12
        release = threading.Event()
        returned = threading.Event()
        def invoke(name, arguments, task, call_id, **kwargs):
            if call_id == "slow":
                release.wait(3)
                returned.set()
            return call_id + "-result"
        agent._invoke_tool = invoke
        messages = [{"role": "assistant", "content": "已有正文"}]
        try:
            self.run_batch(agent, self.calls(), messages)
            self.assertIn("timed out", messages[1]["content"])
            self.assertEqual(messages[2]["content"], "fast-result")
            self.assertEqual(self.persisted[0][-1]["tool_call_id"], "fast")
            count = len(self.updates)
        finally:
            release.set()
        self.assertTrue(returned.wait(2))
        self.assertEqual(len(self.updates), count)

    def test_cancel_preserves_completed_result(self):
        agent = self.agent()
        def invoke(name, arguments, task, call_id, **kwargs):
            if call_id == "fast":
                return "fast-result"
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not agent._interrupt_requested:
                time.sleep(0.005)
            return '{"error":"Tool execution cancelled","status":"cancelled"}'
        agent._invoke_tool = invoke
        original = agent.tool_progress_callback
        def callback(kind, name=None, preview=None, args=None, **details):
            original(kind, name, preview, args, **details)
            if kind == "tool.completed" and details.get("tool_call_id") == "fast":
                agent._interrupt_requested = True
        agent.tool_progress_callback = callback
        messages = [{"role": "assistant", "content": "保留阶段结论"}]
        self.run_batch(agent, self.calls(), messages)
        self.assertEqual(messages[0]["content"], "保留阶段结论")
        self.assertEqual(messages[2]["content"], "fast-result")
        self.assertIn("cancelled", messages[1]["content"])
        self.assertEqual(len([item for item in self.updates if getattr(item, "status", None) in ("completed", "failed")]), 2)

    def test_persistence_failure_does_not_publish_completion(self):
        agent = self.agent()
        agent._invoke_tool = lambda *args, **kwargs: "result"
        agent._flush_messages_to_session_db = lambda messages: False
        self.run_batch(agent, self.calls(), [])
        self.assertTrue(agent._incremental_persistence_failed)
        self.assertFalse([item for item in self.updates if getattr(item, "status", None) in ("completed", "failed")])

    def test_database_reload_preserves_out_of_order_completions_without_duplicates(self):
        from hermes_state import SessionDB
        from run_agent import AIAgent
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.db"
            database = SessionDB(db_path=path)
            database.create_session(session_id="isolated", source="acp", model="fixture")
            agent = self.agent()
            agent._session_db = database
            agent._session_db_created = True
            agent._last_flushed_db_idx = 0
            agent._flushed_db_message_ids = set()
            agent._persist_disabled = False
            agent._flush_messages_to_session_db_unlocked = AIAgent._flush_messages_to_session_db_unlocked.__get__(agent)
            agent._flush_messages_to_session_db = AIAgent._flush_messages_to_session_db.__get__(agent)
            calls = self.calls()
            messages = [{"role": "assistant", "content": "已有结论", "tool_calls": [
                {"id": item.id, "type": "function", "function": {"name": item.function.name, "arguments": item.function.arguments}}
                for item in calls]}]
            completed = threading.Event()
            callback = agent.tool_progress_callback
            def progress(kind, name=None, preview=None, args=None, **details):
                callback(kind, name, preview, args, **details)
                if kind == "tool.completed" and details.get("tool_call_id") == "fast":
                    recovered = database.get_messages_as_conversation("isolated")
                    if any(item.get("tool_call_id") == "fast" for item in recovered):
                        completed.set()
            agent.tool_progress_callback = progress
            def invoke(name, arguments, task, call_id, **kwargs):
                if call_id == "slow":
                    completed.wait(2)
                return call_id + "-durable"
            agent._invoke_tool = invoke
            try:
                self.run_batch(agent, calls, messages)
                self.assertTrue(completed.is_set())
                self.assertTrue(agent._flush_messages_to_session_db(messages))
            finally:
                database.close()
            reopened = SessionDB(db_path=path)
            try:
                restored = reopened.get_messages_as_conversation("isolated")
                results = [item for item in restored if item["role"] == "tool"]
                self.assertEqual(len(results), 2)
                self.assertEqual({item["tool_call_id"]: item["content"] for item in results},
                                 {"slow": "slow-durable", "fast": "fast-durable"})
                self.assertEqual(restored[0]["content"], "已有结论")
            finally:
                reopened.close()

    def test_sequential_result_publishes_before_next_tool(self):
        agent = self.agent()
        messages = []
        observations = []
        def middleware(current, **kwargs):
            tool_executor._begin_tool_execution(current, function_name=kwargs["function_name"],
                function_args=kwargs["function_args"], effective_task_id="isolated",
                tool_call_id=kwargs["tool_call_id"], display_index=kwargs["display_index"])
            observations.append(len([item for item in self.updates if getattr(item, "status", None) == "completed"]))
            return SimpleNamespace(result=kwargs["tool_call_id"] + "-result", args=kwargs["function_args"], middleware_trace=[], blocked=False)
        with patch.object(tool_executor, "_run_agent_tool_execution_middleware", side_effect=middleware), \
             patch.object(tool_executor, "get_active_env", return_value=None):
            tool_executor.execute_tool_calls_sequential(agent, SimpleNamespace(tool_calls=self.calls()), messages, "isolated")
        self.assertEqual(observations, [0, 1])
        self.assertEqual(len(self.persisted), 2)
        self.assertFalse(self.queues)

    def test_search_timeout_skips_probe_but_keeps_partial_matches(self):
        operations = object.__new__(file_operations.ShellFileOperations)
        operations._has_command = lambda name: True
        operations._zero_match_probe = Mock(return_value="probe")
        for matches in ([], [file_operations.SearchMatch(path="found.js", line_number=1, content="hit")]):
            with self.subTest(partial=bool(matches)):
                result = file_operations.SearchResult(matches=matches, total_count=len(matches), truncated=True, limit_reason="search_timeout")
                operations._search_with_rg = lambda *args: result
                actual = operations._search_content("hit", ".", None, 40, 0, "content", 0)
                self.assertEqual(actual.matches, matches)
                self.assertIn("搜索超时", actual.to_dict()["error"])
        operations._zero_match_probe.assert_not_called()

    def test_normal_empty_search_still_probes_and_success_stays_success(self):
        operations = object.__new__(file_operations.ShellFileOperations)
        operations._has_command = lambda name: True
        operations._zero_match_probe = Mock(return_value="casing hint")
        operations._search_with_rg = lambda *args: file_operations.SearchResult()
        result = operations._search_content("hit", ".", None, 40, 0, "content", 0)
        self.assertEqual(result.warning, "casing hint")
        self.assertNotIn("error", result.to_dict())

    def test_search_tool_timeout_is_failed_and_has_no_pagination_hint(self):
        result = file_operations.SearchResult(files=["found.txt"], total_count=1, truncated=True, limit_reason="search_timeout")
        with patch.object(file_tools, "_get_file_ops", return_value=SimpleNamespace(search=lambda **kwargs: result)), \
             patch.object(file_tools, "_filter_read_blocked_search_results", return_value=0), \
             patch.object(file_tools, "get_read_block_error", return_value=None), \
             patch.object(file_tools, "_check_not_found_cache", return_value=None), \
             patch.object(file_tools, "_resolve_path_for_task", return_value=Path.cwd()):
            output = file_tools.search_tool("hit", path=".", task_id="timeout-fixture")
        self.assertNotIn("Use offset", output)
        self.assertEqual(json.loads(output)["files"], ["found.txt"])
        self.assertEqual(events.build_tool_complete("id", "search_files", result=output).status, "failed")

    def test_install_is_idempotent_and_unrecognized_source_is_rejected(self):
        original = tool_executor.execute_tool_calls_concurrent
        install_tool_execution()
        self.assertIs(original, tool_executor.execute_tool_calls_concurrent)
        with self.assertRaises(RuntimeError):
            replace_once("changed", "expected", "replacement")

    def test_real_fallback_search_handles_regex_paths_and_gitignore(self):
        from tools.environments.local import LocalEnvironment
        with tempfile.TemporaryDirectory(prefix="baiqiu-search-") as directory:
            root = Path(directory) / "中文 空格"
            root.mkdir()
            (root / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
            (root / "first.txt").write_text("alpha\nbeta\n", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.txt").write_text("alpha", encoding="utf-8")
            environment = LocalEnvironment(cwd=directory, timeout=5)
            operations = file_operations.ShellFileOperations(environment)
            operations._command_cache["rg"] = False
            try:
                for mode in ("content", "files_only", "count"):
                    with self.subTest(mode=mode):
                        result = operations.search("alpha|beta", path=str(root), output_mode=mode)
                        self.assertIsNone(result.error)
                        self.assertIsNone(result.limit_reason)
                        self.assertEqual(result.total_count, 1 if mode == "files_only" else 2)
                        paths = result.files or list(result.counts) or [item.path for item in result.matches]
                        self.assertTrue(all(Path(item) == root / "first.txt" for item in paths))
                explicit = operations.search("alpha|beta", path=str(root / "node_modules"), output_mode="content")
                self.assertEqual(explicit.total_count, 1)
                glob = operations.search("alpha|beta", path=str(root), file_glob="first.txt")
                self.assertEqual(glob.total_count, 2)
            finally:
                environment.cleanup()

    def test_real_rg_search_handles_windows_path_and_filename_search(self):
        from tools.environments.local import LocalEnvironment
        with tempfile.TemporaryDirectory(prefix="baiqiu-rg-") as directory:
            root = Path(directory) / "中文 空格"
            root.mkdir()
            (root / "fixture.txt").write_text("alpha\nbeta\n", encoding="utf-8")
            environment = LocalEnvironment(cwd=directory, timeout=5)
            operations = file_operations.ShellFileOperations(environment)
            try:
                if not operations._has_command("rg"):
                    self.skipTest("rg is not installed in this test environment")
                result = operations.search("alpha|beta", path=str(root))
                self.assertIsNone(result.error)
                self.assertEqual(result.total_count, 2)
                files = operations.search("*.txt", target="files", path=str(root))
                self.assertIsNone(files.error)
                self.assertEqual(len(files.files), 1)
                self.assertEqual(Path(files.files[0]), root / "fixture.txt")
            finally:
                environment.cleanup()

    def test_git_warnings_are_not_returned_as_file_paths(self):
        diagnostics, payload = split_git_diagnostics("warning: broken link\nfirst.txt\n")
        self.assertIn("broken link", diagnostics)
        self.assertEqual(payload, "first.txt")


if __name__ == "__main__":
    unittest.main()
