import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_protocol_recovery import ProtocolRecovery


def replay(database, baseline):
    spec = importlib.util.spec_from_file_location("baseline_recovery", baseline)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    connection = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
    messages = connection.execute("SELECT id, content FROM messages WHERE id IN (7790,7791,7792) ORDER BY id").fetchall()
    connection.close()
    if len(messages) != 3:
        raise ValueError("Affected public messages unavailable")
    results = {}
    for name, recovery_type in (("before", module.ProtocolRecovery), ("after", ProtocolRecovery)):
        diagnostics = []
        recovery = recovery_type(diagnostics.append)
        agent = SimpleNamespace(_build_assistant_message=lambda response, finish: {"role": "assistant", "content": response.content},
            _flush_messages_to_session_db=lambda messages, history: None, _emit_interim_assistant_message=lambda message: None)
        history = []
        consumed = []
        for ident, content in messages:
            response = SimpleNamespace(content=content, tool_calls=None, finish_reason="stop")
            decision = recovery.inspect(agent, response, history, [])
            consumed.append(ident)
            if decision != "retry":
                break
        results[name] = {"additionalModelRequests": recovery.attempts, "consumedMessageIds": consumed,
                         "decisions": [event["phase"] for event in diagnostics]}
    assert results["before"]["additionalModelRequests"] == 2
    assert results["after"]["additionalModelRequests"] == 0
    assert results["after"]["decisions"] == ["warning"]
    return results


if __name__ == "__main__":
    print(json.dumps(replay(*sys.argv[1:]), ensure_ascii=False))
