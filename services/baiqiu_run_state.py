import hashlib
import json
import os
from pathlib import Path
import time
import uuid


class RunStateStore:
    def __init__(self, root):
        self.root = Path(root)
        self.active = {}

    def path(self, session_id, turn_id):
        identity = json.dumps([session_id, turn_id], ensure_ascii=False, separators=(",", ":")).encode()
        return self.root / (hashlib.sha256(identity).hexdigest() + ".json")

    def begin(self, session_id, turn_id):
        current = self.active.get(session_id)
        if current and current["status"] == "running":
            raise RuntimeError("Black Ball already owns an active turn")
        record = dict(sessionId=session_id, turnId=turn_id, status="running",
                      eventId="run-state:" + str(uuid.uuid4()), sequence=1,
                      target="execution", type="run_state", source="black_ball_runtime",
                      startedAt=int(time.time() * 1000), updatedAt=int(time.time() * 1000),
                      tools={}, updates=[], runtimeResult=None)
        self.active[session_id] = record
        try:
            self.checkpoint(record)
        except Exception:
            del self.active[session_id]
            raise
        return record

    def checkpoint(self, record):
        serialized = json.dumps({**record, "updates": list(record["updates"]),
            "tools": {identity: dict(tool) for identity, tool in dict(record["tools"]).items()}}, ensure_ascii=False)
        self.root.mkdir(parents=True, exist_ok=True)
        destination = self.path(record["sessionId"], record["turnId"])
        temporary = destination.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("w", encoding="utf-8") as output:
                output.write(serialized)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)

    def observe(self, session_id, update):
        record = self.active.get(session_id)
        if not record or record["status"] != "running":
            return
        payload = update.model_dump(by_alias=True, exclude_none=True)
        record["updatedAt"] = int(time.time() * 1000)
        kind = payload.get("sessionUpdate")
        if kind in ("tool_call", "tool_call_update"):
            identity = payload.get("toolCallId")
            if identity:
                tool = record["tools"].setdefault(identity, {"status": "running"})
                for key in ("title", "status"):
                    if payload.get(key):
                        tool[key] = payload[key]
        if kind == "agent_thought_chunk":
            return
        sequence = len(record["updates"]) + 1
        envelope = {"turnId": record["turnId"], "eventId": record["eventId"] + ":" + str(sequence),
                    "sequence": sequence}
        update.field_meta = {**(getattr(update, "field_meta", None) or {}), "baiqiuRunEvent": envelope}
        payload["_meta"] = update.field_meta
        record["updates"].append(payload)

    def capture(self, record, result):
        if record["status"] == "running":
            record["runtimeResult"] = {key: result.get(key) for key in ("completed", "failed", "interrupted", "error")}
        return result

    def finish(self, record, stop_reason, error=False):
        if record["status"] != "running":
            return self.snapshot_record(record)
        pending = [key for key, tool in record["tools"].items()
                   if tool.get("status") not in ("completed", "failed", "cancelled")]
        result = record.get("runtimeResult") or {}
        if stop_reason == "cancelled" or result.get("interrupted"):
            status = "cancelled"
        elif error or result.get("error") or result.get("failed") or stop_reason != "end_turn":
            status = "failed"
        elif (not pending and result.get("completed") is True and record.get("completion", {}).get("status") == "awaiting_input"
              and all(item["status"] in ("addressed", "needs_clarification") for item in record.get("supplements", {}).values())):
            status = "awaiting_input"
        elif (pending or record.get("pendingSupplementIds") or result.get("completed") is not True
              or (record.get("supplements") and (record.get("completion", {}).get("status") != "completed"
                  or record.get("completion", {}).get("scope") != "active_task"))):
            status = "incomplete"
        else:
            status = "completed"
        committed = {**record, "status": status, "stopReason": stop_reason, "sequence": 2,
                     "updatedAt": int(time.time() * 1000), "pendingToolIds": pending}
        committed.pop("runtimeResult", None)
        self.checkpoint(committed)
        record.clear()
        record.update(committed)
        outcome = self.snapshot(record["sessionId"], record["turnId"])
        if self.active.get(record["sessionId"]) is record:
            del self.active[record["sessionId"]]
        return outcome

    def snapshot(self, session_id, turn_id, after_sequence=None):
        record = self.active.get(session_id)
        if not record or record["turnId"] != turn_id:
            try:
                record = json.loads(self.path(session_id, turn_id).read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {"sessionId": session_id, "turnId": turn_id, "status": "unknown"}
        return self.snapshot_record(record, after_sequence)

    def snapshot_record(self, record, after_sequence=None):
        result = json.loads(json.dumps({key: value for key, value in record.items() if key not in ("updates", "runtimeResult")}))
        result["eventCount"] = len(record["updates"])
        if after_sequence is not None:
            result["updates"] = record["updates"][max(0, int(after_sequence)):]
        return result


class ObservedConnection:
    def __init__(self, connection, store):
        self.connection = connection
        self.store = store

    def __getattr__(self, name):
        return getattr(self.connection, name)

    async def session_update(self, session_id, update, **kwargs):
        self.store.observe(session_id, update)
        return await self.connection.session_update(session_id, update, **kwargs)
