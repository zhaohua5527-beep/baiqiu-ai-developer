import json
import sys
from pathlib import Path

root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "services"))
from baiqiu_supplements import TurnSupplements, bind_supplements


class ModelRequestProbe:
    api_mode = "chat_completions"

    def __init__(self):
        self.received = []

    def redirect(self, text):
        self.received.append(text)
        return True

    def _build_api_kwargs(self, messages):
        return {"messages": messages}


request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
revision = json.loads(request["text"][request["text"].index("{"):])
assert revision["original"] == "const value = 1;"
assert revision["revised"] == 'const value = "用户修改 <tag> & 值";'
assert revision["sessionId"] == request["sessionId"] == "session-a"
assert revision["revisionId"] == request["supplementId"]
agent = ModelRequestProbe()
events = []
record = {"turnId": request["runId"]}
channel = TurnSupplements(agent, record, events.append, lambda: False)
restore = bind_supplements(agent, channel)
try:
    receipt = channel.receive(request["supplementId"], request["text"])
    assert receipt["status"] == "accepted"
    assert request["text"] in agent.received[0]
    built = agent._build_api_kwargs([{"role": "user", "content": agent.received[0]}])
    assert request["text"] in built["messages"][0]["content"]
    assert record["supplements"][request["supplementId"]]["status"] == "applied"
    channel.receive(request["supplementId"], request["text"])
    assert len(agent.received) == 1
    assert [event["stage"] for event in events] == ["accepted", "applied"]
finally:
    restore()
print(json.dumps({"ok": True, "checks": 10, "root": str(root), "networkCalls": 0}, ensure_ascii=False))
