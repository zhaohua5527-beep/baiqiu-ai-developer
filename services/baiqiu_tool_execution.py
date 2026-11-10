import inspect
import importlib
import os
import re
import shlex
import threading
import textwrap
from pathlib import Path


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise RuntimeError("Unsupported Hermes tool execution source: " + before[:100])
    return source.replace(before, after, 1)


def compile_function(original, source):
    namespace = {}
    exec(compile(source, inspect.getfile(original), "exec"), original.__globals__, namespace)
    return namespace[original.__name__]


def patch_function(original, before, after):
    source = textwrap.dedent(inspect.getsource(original))
    return compile_function(original, replace_once(source, before, after))


def quote_rg_path(operations, path):
    from tools.environments.local import LocalEnvironment, _msys_to_windows_path
    if os.name == "nt" and isinstance(operations.env, LocalEnvironment):
        return shlex.quote(_msys_to_windows_path(path))
    return operations._escape_shell_arg(path)


def split_git_diagnostics(stdout):
    from tools.file_operations import _split_tool_diagnostics
    diagnostics, payload = _split_tool_diagnostics(stdout)
    lines = []
    for line in payload.splitlines():
        if line.startswith(("warning: ", "fatal: ", "error: ")):
            diagnostics += "\n" + line
        else:
            lines.append(line)
    return diagnostics, "\n".join(lines)


_LONG_READ_ONLY_TERMINAL_RE = re.compile(
    r"(?:\bdu\s+-[^\n]*\b|\bfind\s+[/~]|\b(?:rg|grep)\s+-[^\n]*r|"
    r"\b(?:get-childitem|gci|dir)\b[^\n]*-recurse|\bls\s+-[^\n]*r)",
    re.IGNORECASE,
)
_TERMINAL_MUTATION_RE = re.compile(
    r"(?:\brm\b|\bdel(?:ete)?\b|\bmove-item\b|\bcopy-item\b|\bset-content\b|"
    r"\bmkdir\b|\binstall\b|\brename-item\b|(?:^|\s)(?:>|>>))",
    re.IGNORECASE,
)


def should_handoff_long_terminal(command, timeout=None, background=False):
    if background or not isinstance(command, str) or not command.strip():
        return False
    if _TERMINAL_MUTATION_RE.search(command):
        return False
    if _LONG_READ_ONLY_TERMINAL_RE.search(command):
        return True
    return False


def install_long_terminal_handoff(terminal_module):
    if getattr(terminal_module, "_baiqiu_long_terminal_handoff", False):
        return
    original = terminal_module.terminal_tool

    def terminal_with_handoff(
        command, background=False, timeout=None, task_id=None, session_id=None,
        force=False, workdir=None, pty=False, notify_on_complete=False,
        watch_patterns=None,
    ):
        handoff = should_handoff_long_terminal(command, timeout, background)
        return original(
            command=command,
            background=background or handoff,
            timeout=timeout,
            task_id=task_id,
            session_id=session_id,
            force=force,
            workdir=workdir,
            pty=pty,
            notify_on_complete=True if handoff else notify_on_complete,
            watch_patterns=None if handoff else watch_patterns,
        )

    terminal_module.terminal_tool = terminal_with_handoff
    terminal_module._baiqiu_long_terminal_handoff = True


def git_fallback(original, grep):
    source = textwrap.dedent(inspect.getsource(original))
    source = replace_once(source, 'cmd_parts = ["grep", "-rnH"]',
        'cmd_parts = ["git", "-C", _baiqiu_quote_rg_path(self, path), "-c", "core.quotePath=false", '
        '"grep", "--no-index", "--exclude-standard", "--no-color", "-n", "-H", "-I", "-E"]')
    source = replace_once(source, '    cmd_parts.append("--exclude-dir=\'.*\'")', '')
    source = replace_once(source, 'cmd_parts.append(self._escape_shell_arg(pattern))',
        'cmd_parts.extend(["-e", self._escape_shell_arg(pattern), "--"])')
    source = replace_once(source, 'cmd_parts.append(self._escape_shell_arg(path))', 'cmd_parts.append(".")')
    source = replace_once(source, 'if result.exit_code == 2 and not payload.strip():',
        'if result.exit_code not in (0, 1, 141) and not limit_reason:')
    source = replace_once(source, '_split_tool_diagnostics(stdout)', '_baiqiu_split_git_diagnostics(stdout)')
    git = compile_function(original, source)

    def search(operations, pattern, path, file_glob, limit, offset, output_mode, context):
        from tools.environments.local import LocalEnvironment, _msys_to_windows_path
        if isinstance(operations.env, LocalEnvironment) and not file_glob:
            target = Path(_msys_to_windows_path(path))
            if not target.is_absolute():
                target = Path(_msys_to_windows_path(operations.env.cwd)) / target
            if target.is_dir() and operations._has_command("git"):
                result = git(operations, pattern, str(target), None, limit, offset, output_mode, context)
                for match in result.matches:
                    match.path = str(target / match.path)
                result.files = [str(target / item) for item in result.files]
                result.counts = {str(target / item): count for item, count in result.counts.items()}
                return result
        return grep(operations, pattern, path, file_glob, limit, offset, output_mode, context)

    return search


def incremental_executor(original):
    source = inspect.getsource(original)
    start = source.index("    # ── Post-execution: display per-tool results")
    end = source.index("    # ── Per-turn aggregate budget enforcement", start)
    block = source[start:end]
    block = replace_once(block, "        r = results[i]", "        if i not in indices or i in processed:\n            continue\n        processed.add(i)\n        r = results[i]")
    block = replace_once(block, "        messages.append(tool_message)", "        completed_messages[i] = tool_message\n        messages.append(tool_message)")
    block = replace_once(block, "                    result=display_function_result,", "                    result=display_function_result, tool_call_id=tc.id,")
    source = source[:start] + (
        "    drain_completed(range(num_tools))\n"
        "    if getattr(agent, '_incremental_persistence_failed', False):\n"
        "        return\n"
        "    messages[message_start:] = [completed_messages[index] for index in sorted(completed_messages)]\n\n"
    ) + source[end:]
    source = replace_once(source, "    # Start spinner for CLI mode", (
        "    processed = set()\n"
        "    completed_messages = {}\n"
        "    message_start = len(messages)\n\n"
        "    def drain_completed(indices):\n"
        "        if getattr(agent, '_incremental_persistence_failed', False):\n"
        "            return\n" + textwrap.indent(block, "    ") + "\n"
        "    # Start spinner for CLI mode"
    ))
    source = source.replace("futures, timeout=wait_timeout,", "pending_futures, timeout=wait_timeout, return_when=concurrent.futures.FIRST_COMPLETED,")
    source = replace_once(source, "                while True:\n                    wait_timeout", "                while True:\n                    pending_futures = [future for future in futures if future_to_index[future] not in processed]\n                    wait_timeout")
    source = replace_once(source, "                    if not not_done:\n                        break", (
        "                    drain_completed({future_to_index[future] for future in futures if future.done()})\n"
        "                    if getattr(agent, '_incremental_persistence_failed', False):\n"
        "                        abandon_executor = True\n"
        "                        for future in not_done:\n"
        "                            future.cancel()\n"
        "                        break\n"
        "                    if not not_done:\n                        break"
    ))
    return compile_function(original, source)


def install_tool_execution():
    from agent import tool_executor
    from tools import file_operations, file_tools
    terminal_module = importlib.import_module("tools.terminal_tool")
    from acp_adapter import events, server, tools as acp_tools

    if getattr(tool_executor, "_baiqiu_incremental_results", False):
        return

    install_long_terminal_handoff(terminal_module)

    original_start = acp_tools.build_tool_start

    def build_tool_start(tool_call_id, tool_name, arguments, **kwargs):
        update = original_start(tool_call_id, tool_name, arguments, **kwargs)
        fields = {
            "search_files": ("pattern", "path", "target", "file_glob", "output_mode"),
            "read_file": ("path", "offset", "limit"),
        }.get(tool_name, ())
        if fields and isinstance(arguments, dict):
            update.raw_input = {field: arguments[field] for field in fields if field in arguments}
        return update

    concurrent = incremental_executor(tool_executor.execute_tool_calls_concurrent)
    sequential = patch_function(
        tool_executor.execute_tool_calls_sequential,
        "                    result=display_function_result,",
        "                    result=display_function_result, tool_call_id=tool_call.id,",
    )
    preflight = patch_function(
        tool_executor._begin_tool_execution,
        '                "tool.started", function_name, preview, display_args',
        '                "tool.started", function_name, preview, display_args, tool_call_id=tool_call_id',
    )
    search = patch_function(
        file_operations.ShellFileOperations._search_content,
        "if (not result.error and result.total_count == 0",
        "if (not result.error and not result.limit_reason and result.total_count == 0",
    )
    serialize = patch_function(
        file_operations.SearchResult.to_dict,
        "    if self.error:\n        result[\"error\"] = self.error",
        "    if self.limit_reason == 'search_timeout':\n"
        "        result['error'] = '搜索超时，结果不完整，不能据此判断没有匹配。请缩小目录或指定 file_glob 后继续。'\n"
        "    if self.error:\n        result['error'] = self.error",
    )
    search_tool = patch_function(
        file_tools.search_tool,
        'if result_dict.get("truncated"):',
        'if result_dict.get("truncated") and not result_dict.get("limit_reason"):',
    )
    grep = patch_function(
        file_operations.ShellFileOperations._search_with_grep,
        'cmd_parts = ["grep", "-rnH"]',
        'cmd_parts = ["grep", "-ErnH", "--line-buffered"]',
    )
    fallback = git_fallback(file_operations.ShellFileOperations._search_with_grep, grep)
    rg_methods = {}
    for name in ("_search_with_rg", "_search_files_rg", "_zero_match_probe"):
        original = getattr(file_operations.ShellFileOperations, name)
        source = textwrap.dedent(inspect.getsource(original))
        if "self._escape_shell_arg(path)" not in source:
            raise RuntimeError("Unsupported Hermes search path source: " + name)
        source = source.replace("self._escape_shell_arg(path)", "_baiqiu_quote_rg_path(self, path)")
        rg_methods[name] = compile_function(original, source)
    original_factory = events.make_tool_progress_cb

    def progress_factory(conn, session_id, loop, tool_call_ids, tool_call_meta, **kwargs):
        original = original_factory(conn, session_id, loop, tool_call_ids, tool_call_meta, **kwargs)
        identities = {}
        lock = threading.RLock()

        def progress(event_type, name=None, preview=None, args=None, **details):
            with lock:
                call_id = details.get("tool_call_id")
                if event_type == "tool.started":
                    original(event_type, name, preview, args, **details)
                    queue = tool_call_ids.get(name)
                    if call_id and queue:
                        identities[call_id] = queue[-1]
                    return
                if event_type != "tool.completed" or call_id not in identities:
                    return original(event_type, name, preview, args, **details)
                display_id = identities[call_id]
                meta = tool_call_meta.get(display_id, {})
                result = details.get("result")
                update = events.build_tool_complete(
                    display_id, name, result=result,
                    function_args=meta.get("args"), snapshot=meta.get("snapshot"),
                )
                events._send_update(conn, session_id, loop, update)
                identities.pop(call_id)
                tool_call_meta.pop(display_id, None)
                queue = tool_call_ids.get(name)
                if queue and display_id in queue:
                    queue.remove(display_id)
                    if not queue:
                        tool_call_ids.pop(name, None)
                if name == "todo":
                    plan = events._build_plan_update_from_todo_result(result)
                    if plan is not None:
                        events._send_update(conn, session_id, loop, plan)

        return progress

    tool_executor.execute_tool_calls_concurrent = concurrent
    tool_executor.execute_tool_calls_sequential = sequential
    tool_executor._begin_tool_execution = preflight
    file_operations.ShellFileOperations._search_content = search
    file_operations.ShellFileOperations._search_with_grep = fallback
    file_operations._baiqiu_quote_rg_path = quote_rg_path
    file_operations._baiqiu_split_git_diagnostics = split_git_diagnostics
    for name, method in rg_methods.items():
        setattr(file_operations.ShellFileOperations, name, method)
    file_operations.SearchResult.to_dict = serialize
    file_tools.search_tool = search_tool
    events.make_tool_progress_cb = progress_factory
    server.make_tool_progress_cb = progress_factory
    acp_tools.build_tool_start = build_tool_start
    events.build_tool_start = build_tool_start
    server.build_tool_start = build_tool_start
    tool_executor._baiqiu_incremental_results = True
