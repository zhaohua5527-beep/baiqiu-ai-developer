import argparse
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    settings = json.loads(args.config.read_text(encoding="utf-8-sig"))["settings"]
    config = settings["providers"][settings["defaultProvider"]]
    prompt = subprocess.check_output(["node", "-e", "process.stdout.write(require('./services/public-response-protocol').publicResponseStreamPrompt())"], cwd=root).decode("utf-8")
    reports = []
    with tempfile.TemporaryDirectory(prefix="baiqiu-stage-live-") as home:
        os.environ["HERMES_HOME"] = home
        logging.disable(logging.CRITICAL)
        sys.path.insert(0, str(root / "services"))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from run_agent import AIAgent
            from baiqiu_stage_delivery import bind_stage_delivery, progress_payloads
            from baiqiu_protocol_recovery import install_protocol_recovery
            install_protocol_recovery()
        fixtures = {
            "read_fixture A": {"rows": [45, 75], "unit": "元", "next_file": "B"},
            "read_fixture B": {"rows": [80, 70], "unit": "元"},
            "read_fixture missing": {"found": False, "error": "文件不存在，没有业务数据"},
        }
        cases = [
            ("direct", "只回答：7 加 8 等于多少？不用工具。"),
            ("two_parts", "逐份核对两张表的合计。先读取 A，第二份文件名在 A 的 next_file 中，取得后再读取第二份。分别列出每份金额和合计。"),
            ("no_result", "读取 missing。如果不存在，说明缺少数据并结束，不要估算金额或编造分析结果。"),
        ]
        schema = [{"type": "function", "function": {"name": "terminal", "description": "隔离测试的只读文件工具。command 仅支持 read_fixture A、read_fixture B、read_fixture missing。", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}]
        for name, request in cases:
            started = time.monotonic()
            timeline = []
            report = {"case": name, "provider": settings["defaultProvider"], "model": config["model"]}

            def execute(function_name, function_args, *extra, **kwargs):
                if isinstance(function_args, str):
                    function_args = json.loads(function_args)
                command = function_args.get("command", "")
                if function_name != "terminal" or command not in fixtures:
                    raise ValueError("Only isolated fixture reads are permitted")
                timeline.append({"kind": "tool", "command": command})
                return json.dumps(fixtures[command], ensure_ascii=False)

            def publish(conn, session_id, loop, update):
                timeline.append({"kind": "diagnostic", **update.field_meta["baiqiu_diagnostic"]})

            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    with patch("run_agent.get_tool_definitions", return_value=schema), patch("run_agent.check_toolset_requirements", return_value={}):
                        agent = AIAgent(api_key=config["apiKey"], base_url=config["baseURL"], model=config["model"],
                            api_mode="chat_completions", max_iterations=6, quiet_mode=True, skip_context_files=True, skip_memory=True)
                    agent.client = agent.client.with_options(timeout=40, max_retries=0)
                    agent._cached_system_prompt = prompt
                    agent._use_prompt_caching = False
                    agent.tool_delay = 0
                    agent.compression_enabled = False
                    agent.save_trajectories = False
                    with patch("acp_adapter.events._send_update", side_effect=publish):
                        delivery, restore = bind_stage_delivery(agent, None, name, None, lambda: False, name)
                        try:
                            with patch.object(agent, "_persist_session"), patch.object(agent, "_flush_messages_to_session_db"), patch.object(agent, "_save_trajectory"), patch.object(agent, "_cleanup_task_resources"), patch("run_agent.handle_function_call", side_effect=execute):
                                result = agent.run_conversation(request)
                        finally:
                            restore()
                            agent.client.close()
                messages = [message.get("content", "") for message in result.get("messages", []) if message.get("role") == "assistant"]
                stages = [payload for message in messages for payload in progress_payloads(message) if payload.get("type") == "stage_result"]
                tool_commands = [item["command"] for item in timeline if item["kind"] == "tool"]
                authored = [index for index, item in enumerate(timeline) if item.get("stage") == "authored" and item.get("evidenceResolved")]
                second_read = next((index for index, item in enumerate(timeline) if item.get("command") == "read_fixture B"), -1)
                passed = bool(result.get("completed"))
                if name == "direct":
                    passed = passed and not stages and not tool_commands and "15" in str(messages)
                elif name == "two_parts":
                    passed = passed and tool_commands == ["read_fixture A", "read_fixture B"] and any(index < second_read for index in authored) and any("120" in stage.get("message", "") for stage in stages) and "150" in str(messages)
                else:
                    passed = passed and tool_commands == ["read_fixture missing"] and not stages
                report.update(passed=passed, completed=result.get("completed"), assistantMessages=messages, timeline=timeline, stageCount=len(stages))
            except Exception as error:
                report.update(passed=False, errorType=type(error).__name__)
            report["elapsedSeconds"] = round(time.monotonic() - started, 2)
            reports.append(report)
            args.output.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({key: report.get(key) for key in ("case", "passed", "completed", "stageCount", "elapsedSeconds", "errorType")}), flush=True)
    return 0 if all(report["passed"] for report in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
