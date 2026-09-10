import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class ToolGenerationBridgeTest(unittest.TestCase):
    def test_skill_preparation_uses_native_cache_keys_without_running_the_agent(self):
        bridge = self.load_bridge()
        calls = []
        context = ModuleType("gateway.session_context")
        context.set_session_vars = lambda **kwargs: calls.append(("context", kwargs)) or "tokens"
        context.clear_session_vars = lambda tokens: calls.append(("clear", tokens))
        coding = ModuleType("agent.coding_context")
        coding.coding_compact_skill_categories = lambda **kwargs: frozenset({"fixture"})
        runtime = ModuleType("run_agent")
        runtime.get_toolset_for_tool = lambda name: "skills" if name == "skill_view" else "files"
        runtime.build_skills_system_prompt = lambda **kwargs: calls.append(("build", kwargs))
        state = SimpleNamespace(session_id="isolated", cwd="project", is_running=False,
                                agent=SimpleNamespace(valid_tool_names={"skill_view", "read_file"}, platform="acp"))
        with patch.dict(sys.modules, {"gateway.session_context": context, "agent.coding_context": coding, "run_agent": runtime}):
            bridge.prepare_skill_index(state)
            self.assertEqual(calls[1][1], {"available_tools": {"skill_view", "read_file"},
                                          "available_toolsets": {"skills", "files"}, "compact_categories": frozenset({"fixture"})})
            self.assertEqual(calls[-1], ("clear", "tokens"))
            state.is_running = True
            bridge.prepare_skill_index(state)
            self.assertEqual(len(calls), 3)
            state.is_running = False
            runtime.build_skills_system_prompt = lambda **kwargs: (_ for _ in ()).throw(ValueError("fixture"))
            with self.assertRaises(ValueError):
                bridge.prepare_skill_index(state)
            self.assertEqual(calls[-1], ("clear", "tokens"))

    def test_native_agent_receives_explicit_endpoint_and_protocol(self):
        bridge = self.load_bridge()
        captured = []
        class Base:
            def _make_agent(self, **kwargs):
                captured.append(kwargs)
                return SimpleNamespace()
        config = {"model": {"provider": "zai", "base_url": "https://open.bigmodel.cn/api/paas/v4",
                            "api_mode": "chat_completions"}}
        manager = bridge.session_manager_class(Base, lambda: config)()
        manager._make_agent(session_id="new")
        self.assertEqual(captured[-1]["base_url"], config["model"]["base_url"])
        self.assertEqual(captured[-1]["api_mode"], "chat_completions")
        manager._make_agent(requested_provider="custom:other", base_url="https://other.invalid/v1", api_mode="anthropic_messages")
        self.assertEqual(captured[-1]["base_url"], "https://other.invalid/v1")
        self.assertEqual(captured[-1]["api_mode"], "anthropic_messages")

    def test_provider_protocol_is_scoped_and_preserves_native_other_providers(self):
        bridge = self.load_bridge()
        protocol = {"id": "glm-preserved-thinking", "provider": "zai", "model": "glm-5.3-flash",
                    "baseURL": "https://open.bigmodel.cn/api/paas/v4", "reasoningEffort": "max",
                    "extraBody": {"thinking": {"type": "enabled", "clear_thinking": False}, "tool_stream": True}}
        agent = SimpleNamespace(provider="zai", model="glm-5.3-flash", api_mode="chat_completions",
                                base_url=protocol["baseURL"], _needs_thinking_reasoning_pad=lambda: False)
        original = {"messages": [{"role": "assistant", "content": None, "reasoning_content": "exact-fixture", "tool_calls": [{"id": "real-id"}]}],
                    "tools": [{"function": {"name": "terminal"}}], "extra_body": {"existing": True}}
        agent._build_api_kwargs = lambda *args, **kwargs: original
        bridge.bind_provider_protocol(agent, protocol)
        request = agent._build_api_kwargs([])
        self.assertTrue(agent._needs_thinking_reasoning_pad())
        self.assertEqual(request["messages"], original["messages"])
        self.assertEqual(request["tools"], original["tools"])
        self.assertEqual(request["extra_body"]["reasoning_effort"], "max")
        self.assertEqual(original["extra_body"], {"existing": True})
        for attribute, value in (("provider", "custom"), ("model", "another-model"), ("api_mode", "anthropic_messages"), ("base_url", "https://proxy.invalid/v1")):
            previous = getattr(agent, attribute)
            setattr(agent, attribute, value)
            self.assertFalse(agent._needs_thinking_reasoning_pad())
            self.assertIs(agent._build_api_kwargs([]), original)
            setattr(agent, attribute, previous)

    def test_tool_completion_normalizes_wire_arguments_without_losing_results(self):
        bridge = self.load_bridge()
        calls = []
        def complete(*args, **kwargs):
            self.assertIsInstance(kwargs["function_args"], dict)
            calls.append(kwargs)
            return kwargs["result"]
        events = SimpleNamespace(build_tool_complete=complete)
        adapter = ModuleType("acp_adapter")
        adapter.events = events
        with patch.dict(sys.modules, {"acp_adapter": adapter}):
            bridge.install_tool_completion_compat()
            installed = events.build_tool_complete
            bridge.install_tool_completion_compat()
            self.assertIs(events.build_tool_complete, installed)
            self.assertEqual(installed("tool-1", "read_file", function_args='{"path":"first.txt"}', result="first-5721"), "first-5721")
            installed("tool-2", "read_file", function_args="invalid", result="failure")
        self.assertEqual(calls[0]["function_args"], {"path": "first.txt"})
        self.assertEqual(calls[1]["function_args"], {"raw": "invalid"})

    def test_custom_provider_resolution_preserves_identity_and_rejects_ambiguity(self):
        bridge = self.load_bridge()
        config = {"model": {"provider": "custom:store", "base_url": "https://proxy.example/v1"}, "custom_providers": [{"name": "store", "base_url": "https://proxy.example/v1"}]}
        self.assertEqual(bridge.canonical_provider(config), "custom:store")
        self.assertEqual(bridge.canonical_provider(config, "custom", "https://proxy.example/v1/"), "custom:store")
        self.assertEqual(bridge.canonical_provider(config, "zai"), "zai")
        with self.assertRaises(ValueError):
            bridge.canonical_provider(config, "custom", "https://other.example/v1")
        config["custom_providers"].append({"name": "another-account", "base_url": "https://proxy.example/v1"})
        with self.assertRaises(ValueError):
            bridge.canonical_provider(config, "custom", "https://proxy.example/v1")

    def test_remote_probe_guard_preserves_local_and_explicit_ollama(self):
        bridge = self.load_bridge()
        calls = []
        routing = SimpleNamespace(_should_probe_ollama_vision=lambda provider, url: calls.append((provider, url)) or True)
        metadata = SimpleNamespace(is_local_endpoint=lambda url: url.startswith("http://localhost"))
        agent_module = ModuleType("agent")
        agent_module.image_routing = routing
        agent_module.model_metadata = metadata
        with patch.dict(sys.modules, {"agent": agent_module}):
            bridge.install_remote_probe_guard()
            bridge.install_remote_probe_guard()
        self.assertFalse(routing._should_probe_ollama_vision("custom", "https://cloud.example/v1"))
        self.assertTrue(routing._should_probe_ollama_vision("custom", "http://localhost:11434/v1"))
        self.assertTrue(routing._should_probe_ollama_vision("ollama", "https://remote-ollama.example/v1"))
        self.assertEqual(len(calls), 2)

    def test_session_manager_persists_named_provider_without_changing_agent_provider(self):
        bridge = self.load_bridge()
        database = SimpleNamespace(get_session=lambda session_id: {"model_config": '{"cwd":"workspace","provider":"custom"}'})
        saved = []
        database.update_session_meta = lambda session_id, metadata, model: saved.append(json.loads(metadata))
        class Base:
            def _make_agent(self, **kwargs):
                self.requested = kwargs["requested_provider"]
                return SimpleNamespace(provider="custom", base_url="https://proxy.example/v1", api_mode="chat_completions")
            def _persist(self, state):
                pass
            def _get_db(self):
                return database
        manager = bridge.session_manager_class(Base, lambda: {"model": {"provider": "custom:store"}})()
        agent = manager._make_agent(session_id="original", cwd="workspace")
        manager._persist(SimpleNamespace(agent=agent, session_id="original", model="test-model"))
        self.assertEqual(manager.requested, "custom:store")
        self.assertEqual(agent.provider, "custom")
        self.assertEqual(saved[0]["provider"], "custom:store")
        self.assertEqual(saved[0]["cwd"], "workspace")

    def load_bridge(self):
        adapter = ModuleType("acp_adapter")
        adapter.entry = SimpleNamespace()
        with patch.dict(sys.modules, {"acp_adapter": adapter}):
            spec = importlib.util.spec_from_file_location(
                "baiqiu_acp_entry", Path(__file__).resolve().parents[1] / "services" / "baiqiu_acp_entry.py"
            )
            bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bridge)
            return bridge

    def test_runtime_requests_never_prepend_interrupted_wrappers(self):
        bridge = self.load_bridge()
        original = "[Runtime context]\nold context\n[User request]\n下周天气如何"
        state = SimpleNamespace(runtime_lock=threading.Lock(), is_running=False, interrupted_prompt_text=original)
        blocks = [SimpleNamespace(type="text", text="[Runtime context]\nnew context\n[User request]\n下周天气如何")]
        self.assertTrue(bridge.discard_interrupted_runtime_prompt(state, blocks))
        self.assertEqual(state.interrupted_prompt_text, "")
        for message in ("继续", "/steer 改查明天"):
            state.interrupted_prompt_text = original
            self.assertFalse(bridge.discard_interrupted_runtime_prompt(state, [SimpleNamespace(type="text", text=message)]))
            self.assertEqual(state.interrupted_prompt_text, original)
        state.is_running = True
        self.assertFalse(bridge.discard_interrupted_runtime_prompt(state, blocks))
        state.is_running = False
        for request in ("你好", "本周天气", "继续上一任务", "重试", "改查明天天气"):
            state.interrupted_prompt_text = original
            blocks = [SimpleNamespace(type="text", text="[Runtime context]\nnew\n[User request]\n" + request), SimpleNamespace(type="image")]
            self.assertTrue(bridge.discard_interrupted_runtime_prompt(state, blocks))
            self.assertEqual(state.interrupted_prompt_text, "")

    def test_history_api_view_removes_wrappers_but_keeps_actual_requests_and_evidence(self):
        bridge = self.load_bridge()
        original = "[Runtime context]\nold rules\n\n[Recent visible conversation]\n用户：四川内江\n\n[TOOLS]\ntools\n\n[User request]\n\n本周天气"
        second = original + "\n\nUser correction/guidance after interrupt: [Runtime context]\nmore rules\n[User request]\n你好"
        history = [{"role": "user", "content": original}, {"role": "user", "content": second}, {"role": "tool", "content": '{"exit_code":0}', "tool_call_id": "tool-1"}, {"role": "assistant", "content": "真实结果", "reasoning_content": "unchanged"}]
        before = json.dumps(history)
        result = bridge.runtime_history_for_request(history)
        self.assertIn("四川内江", result[0]["api_content"])
        self.assertTrue(result[0]["api_content"].endswith("本周天气"))
        self.assertEqual(result[1]["api_content"], "[Previous user request; history only]\n你好")
        self.assertEqual(result[1]["content"], second)
        self.assertIs(result[2], history[2])
        self.assertIs(result[3], history[3])
        self.assertEqual(json.dumps(history), before)
        self.assertEqual(bridge.runtime_history_for_request(result), result)

    def test_prompt_binding_seeds_empty_history_and_preserves_original_persistence(self):
        bridge = self.load_bridge()
        calls = []
        class Agent:
            def run_conversation(self, **kwargs):
                calls.append(kwargs)
                current = kwargs["user_message"]
                history = kwargs["conversation_history"]
                if isinstance(current, str):
                    merged = "\n\n".join([message["content"] for message in history] + [current])
                    return self._build_api_kwargs([{"role": "user", "content": merged}])
                return self._build_api_kwargs([*history, {"role": "user", "content": current}])
            def _build_api_kwargs(self, messages):
                return {"messages": messages}
        agent = Agent()
        prompt = "[Runtime context]\nrules\n\n[Recent visible conversation]\n用户：内江\n\n[TOOLS]\nall tools\n\n[User request]\n本周天气"
        restore = bridge.bind_runtime_context(agent)
        first = agent.run_conversation(user_message=prompt, conversation_history=[], persist_user_message=prompt)
        self.assertEqual(calls[0]["user_message"], prompt)
        self.assertIn("用户：内江", first["messages"][0]["content"])
        history = [{"role": "user", "content": prompt}]
        result = agent.run_conversation(user_message=prompt, conversation_history=history, persist_user_message=prompt)
        current = calls[1]
        wire = result["messages"][0]["content"]
        self.assertEqual(wire.count("[Runtime context]"), 1)
        self.assertEqual(wire.count("Recent visible conversation"), 1)
        self.assertEqual(wire.count("all tools"), 1)
        self.assertIn("history only", wire)
        self.assertIn("内江", wire)
        self.assertEqual(current["persist_user_message"], prompt)
        self.assertEqual(current["user_message"], prompt)
        self.assertNotIn("api_content", history[0])
        nested = prompt + "\n\nUser correction/guidance after interrupt: " + prompt.replace("本周天气", "你好")
        legacy = [{"role": "user", "content": prompt}, {"role": "user", "content": nested}]
        latest = prompt.replace("本周天气", "北京天气")
        restored = agent.run_conversation(user_message=latest, conversation_history=legacy)
        restored_text = restored["messages"][0]["content"]
        self.assertEqual(restored_text.count("[Runtime context]"), 1)
        self.assertEqual(restored_text.count("Recent visible conversation"), 1)
        self.assertNotIn("User correction/guidance after interrupt:", restored_text)
        self.assertIn("你好", restored_text)
        self.assertEqual(legacy[1]["content"], nested)
        merged_history = [{"role": "user", "content": prompt + "\n\n" + prompt.replace("本周天气", "你好")}]
        continued = agent.run_conversation(user_message=latest, conversation_history=merged_history)
        continued_text = continued["messages"][0]["content"]
        self.assertEqual(continued_text.count("[Runtime context]"), 1)
        self.assertEqual(continued_text.count("Recent visible conversation"), 1)
        self.assertIn("本周天气", continued_text)
        self.assertIn("你好", continued_text)
        carried = {"role": "user", "content": prompt, "api_content": bridge.without_visible_history(prompt.split("\n[User request]\n", 1)[0]) + "\n[User request]\n本周天气"}
        replay = bridge.runtime_history_for_request([history[0], carried])
        self.assertEqual(replay[1]["api_content"], "[Previous user request; history only]\n本周天气")
        image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,fixture"}}
        result = agent.run_conversation(user_message=[{"type": "text", "text": prompt}, image], conversation_history=history, persist_user_message=prompt)
        self.assertNotIn("Recent visible conversation", result["messages"][-1]["content"][0]["text"])
        self.assertIs(result["messages"][-1]["content"][1], image)
        self.assertNotIn("_build_api_kwargs", agent.__dict__)
        restore()
        self.assertNotIn("run_conversation", agent.__dict__)

    def test_real_interruption_status_reaches_system_request_view_only(self):
        bridge = self.load_bridge()
        system = {"role": "system", "content": "Keep all native tool and reasoning instructions."}
        class Agent:
            def run_conversation(self, **kwargs):
                return self._build_api_kwargs([system, {"role": "user", "content": kwargs["user_message"]}])
            def _build_api_kwargs(self, messages):
                return messages
        agent = Agent()
        prompt = "[Runtime context]\nrules\n[User request]\n你好"
        restore = bridge.bind_runtime_context(agent, previous_interrupted=True)
        messages = agent.run_conversation(user_message=prompt)
        self.assertIn("Previous turn status", messages[0]["content"])
        self.assertIn("inactive", messages[0]["content"])
        self.assertTrue(messages[0]["content"].startswith(system["content"]))
        self.assertNotIn("Previous turn status", system["content"])
        self.assertTrue(messages[1]["content"].endswith("\n你好"))
        restore()
        restore = bridge.bind_runtime_context(agent)
        messages = agent.run_conversation(user_message=prompt)
        self.assertNotIn("Previous turn status", str(messages))
        restore()

    def test_provider_diagnostic_never_carries_error_body_or_private_request(self):
        bridge = self.load_bridge()
        diagnostic = bridge.provider_error_diagnostic(
            "Our servers are currently overloaded. api_key=private-secret", "APIError", 503,
            {"started_at": 100, "first_chunk_at": 102, "headers": {"Authorization": "secret"}}
        )
        self.assertEqual(diagnostic["code"], "HERMES_PROVIDER_OVERLOADED")
        self.assertEqual(diagnostic["firstChunkAt"], 102000)
        self.assertNotIn("secret", str(diagnostic))
        limit = bridge.provider_error_diagnostic('code=429 reason="WEEKLY_LIMIT_EXCEEDED" private-secret', "RateLimitError", 429)
        self.assertEqual(limit["errorCategory"], "weekly_limit_exceeded")
        self.assertNotIn("private-secret", str(limit))

    def test_observers_preserve_native_callback_and_restore_instance(self):
        bridge = self.load_bridge()
        calls = []
        class Agent:
            def _is_provider_stream_parse_error(self, error):
                return False

            def _invoke_api_request_error_hook(self, **kwargs):
                calls.append(kwargs)
                return "native-result"
        agent = Agent()
        acp = ModuleType("acp")
        acp.update_agent_message_text = lambda text: SimpleNamespace(content=SimpleNamespace(text=text), field_meta=None)
        events = ModuleType("acp_adapter.events")
        sent = []
        events._send_update = lambda conn, session, loop, update: sent.append((session, update))
        with patch.dict(sys.modules, {"acp": acp, "acp_adapter.events": events}):
            restore = bridge.bind_provider_diagnostics(agent, "conn", "session-A", None)
            result = agent._invoke_api_request_error_hook(error_message="servers overloaded", error_type="APIError")
            self.assertEqual(result, "native-result")
            self.assertEqual(len(calls), 1)
            self.assertEqual(sent[0][0], "session-A")
            self.assertEqual(sent[0][1].content.text, "")
            self.assertEqual(sent[0][1].field_meta["baiqiu_diagnostic"]["code"], "HERMES_PROVIDER_OVERLOADED")
            self.assertFalse(agent._is_provider_stream_parse_error(RuntimeError("servers overloaded")))
            self.assertEqual(sent[1][1].field_meta["baiqiu_diagnostic"]["code"], "HERMES_PROVIDER_OVERLOADED")
            restore()
            self.assertNotIn("_invoke_api_request_error_hook", agent.__dict__)
            self.assertNotIn("_is_provider_stream_parse_error", agent.__dict__)
            agent._invoke_api_request_error_hook(error_message="later")
            self.assertEqual(len(sent), 2)

    def test_only_native_callback_publishes_generation_metadata(self):
        adapter = ModuleType("acp_adapter")
        adapter.entry = SimpleNamespace()
        acp = ModuleType("acp")
        acp.update_agent_message_text = lambda text: SimpleNamespace(
            content=SimpleNamespace(text=text), field_meta=None
        )
        events = ModuleType("acp_adapter.events")
        sent = []
        events._send_update = lambda conn, session_id, loop, update: sent.append(
            (conn, session_id, loop, update)
        )
        modules = {"acp_adapter": adapter, "acp": acp, "acp_adapter.events": events}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location(
                "baiqiu_acp_entry",
                Path(__file__).resolve().parents[1] / "services" / "baiqiu_acp_entry.py",
            )
            bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bridge)
            loop = asyncio.new_event_loop()
            try:
                callback = bridge.make_tool_generation_callback("conn", "session-1", loop)
                self.assertEqual(sent, [])
                callback("")
                self.assertEqual(sent, [])
                callback("terminal")
                callback("terminal")
            finally:
                loop.close()
        self.assertEqual(len(sent), 2)
        first = sent[0][3]
        second = sent[1][3]
        self.assertEqual(sent[0][:3], ("conn", "session-1", loop))
        self.assertEqual(first.content.text, "")
        event = first.field_meta["baiqiu_execution"]
        self.assertEqual(event["type"], "tool_generating")
        self.assertEqual(event["message"], "正在生成 terminal 调用参数")
        self.assertGreater(event["timestamp"], 0)
        self.assertNotEqual(event["eventId"], second.field_meta["baiqiu_execution"]["eventId"])
        self.assertNotIn("toolCallId", event)

    def test_http_timings_observe_without_changing_content_or_leaking_secrets(self):
        import httpx
        bridge = self.load_bridge()
        sent = []
        acp = ModuleType("acp")
        acp.update_agent_message_text = lambda text: SimpleNamespace(content=SimpleNamespace(text=text), field_meta=None)
        events = ModuleType("acp_adapter.events")
        events._send_update = lambda conn, session, loop, update: sent.append(update.field_meta["baiqiu_diagnostic"])
        transport = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=httpx.ByteStream(b"real-response"))))
        class Agent:
            def _create_request_openai_client(self, **kwargs):
                return SimpleNamespace(_client=transport)
        agent = Agent()
        with patch.dict(sys.modules, {"acp": acp, "acp_adapter.events": events}):
            restore = bridge.bind_provider_timings(agent, "conn", "session-A", None)
            for attempt in range(2):
                agent._create_request_openai_client(api_kwargs={"messages": [{"role": "user", "content": "private-secret"}]})
                with transport.stream("POST", "https://fixture.invalid/test", content=b"private-secret") as response:
                    self.assertEqual(response.read(), b"real-response")
            self.assertEqual(len(transport.event_hooks["request"]), 1)
            restore()
            self.assertEqual(transport.event_hooks["request"], [])
            self.assertEqual(transport.event_hooks["response"], [])
            self.assertNotIn("_create_request_openai_client", agent.__dict__)
        self.assertNotIn("private-secret", str(sent))
        self.assertEqual(sum(item["stage"] == "http_request" for item in sent), 2)
        self.assertEqual(sum(item["stage"] == "http_headers" for item in sent), 2)
        self.assertEqual(sum(item["stage"] == "first_byte" for item in sent), 2)
        self.assertEqual([item["bytesReceived"] for item in sent if item["stage"] == "stream_closed"], [13, 13])
        transport.close()


if __name__ == "__main__":
    unittest.main()
