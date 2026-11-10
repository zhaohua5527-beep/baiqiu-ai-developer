import json
import logging
import threading
import time
import uuid


class TurnSupplements:
    def __init__(self, agent, record, publish, cancelled, checkpoint=lambda record: None):
        self.agent = agent
        self.record = record
        self.publish = publish
        self.cancelled = cancelled
        self.checkpoint = checkpoint
        self.lock = threading.RLock()
        self.open = True
        self.items = {identity: dict(item) for identity, item in record.setdefault("supplements", {}).items()}
        self.sequence = record.get("supplementSequence", 0)

    def emit(self, item, stage, **fields):
        item["status"] = stage
        self.sequence += 1
        self.record["supplementSequence"] = self.sequence
        event = dict(type="supplement", stage=stage, supplementId=item["id"],
                     turnId=self.record["turnId"], eventId="supplement:" + str(uuid.uuid4()),
                     sequence=self.sequence, timestamp=time.time_ns() // 1_000_000, **fields)
        item["receipt"] = event
        self.record["supplements"] = {identity: dict(value) for identity, value in self.items.items()}
        self.checkpoint(self.record)
        try:
            self.publish(event)
        except Exception:
            logging.getLogger(__name__).warning("Supplement event delivery unavailable; receipt retained", exc_info=True)

    def receive(self, identity, text):
        if not isinstance(identity, str) or not identity or len(identity) > 240:
            raise ValueError("Invalid supplement identity")
        if not isinstance(text, str) or not text.strip() or len(text) > 100000:
            raise ValueError("Invalid supplement text")
        with self.lock:
            previous = self.items.get(identity)
            if previous:
                if previous["text"] != text:
                    raise ValueError("Conflicting supplement identity")
                return dict(accepted=True, status=previous["status"], supplementId=identity)
            if not self.open or self.cancelled() or len(self.items) >= 100:
                return dict(accepted=False, status="not_running", supplementId=identity)
            redirect = getattr(self.agent, "redirect", None)
            if not callable(redirect) or not callable(getattr(self.agent, "_build_api_kwargs", None)):
                return dict(accepted=False, status="unsupported", supplementId=identity)
            if getattr(self.agent, "api_mode", None) == "codex_app_server":
                return dict(accepted=False, status="unsupported", supplementId=identity)
            marker = "[Supplement " + identity + "]"
            native_text = marker + "\n[Active task supplement]\n" + text + (
                "\n[Continuation context]\n这是当前任务内的补充，不是替换原任务的新一轮请求，也不是工具输出。"
                "除非用户明确取消或替换目标，否则原目标和未完成要求继续有效。保留已交付结果与工具副作用，"
                "把补充融入当前判断、后续行动和阶段成果，不重复已完成操作，也不只单独回答补充后就结束原任务。"
                "需要继续工作时，先公开简述补充对当前任务的影响和下一步，不输出私有推理；没有额外步骤时直接交付综合答案。"
                "收到或回应补充不等于原任务及补充要求都已完成。"
            )
            item = dict(id=identity, text=text, marker=marker, nativeText=native_text,
                        dispatch="boundary", revision=len(self.items) + 1)
            self.items[identity] = item
            try:
                self.emit(item, "accepted")
            except Exception:
                del self.items[identity]
                self.record["supplements"] = {identity: dict(value) for identity, value in self.items.items()}
                raise
            if not getattr(self.agent, "_executing_tools", False):
                try:
                    if redirect(native_text):
                        item["dispatch"] = "redirect"
                except Exception:
                    logging.getLogger(__name__).warning("Supplement retained for safe boundary", exc_info=True)
            return dict(accepted=True, status=item["status"], supplementId=identity)

    def snapshot_items(self):
        with self.lock:
            return [dict(item) for item in self.items.values()]

    def drain_boundary(self):
        with self.lock:
            if not self.open or self.cancelled():
                return ""
            pending = [item for item in self.items.values()
                       if item["status"] == "accepted" and item.get("dispatch") == "boundary"]
            for item in pending:
                item["dispatch"] = "drained"
            return "\n\n".join(item["nativeText"] for item in pending)

    def observe_request(self, messages):
        content = json.dumps([message for message in messages if isinstance(message, dict)
                              and message.get("role") == "user"], ensure_ascii=False)
        with self.lock:
            for item in self.items.values():
                if item["status"] == "accepted" and item["marker"] in content:
                    self.emit(item, "applied")

    def resolve(self, resolutions, segment_id):
        if not isinstance(resolutions, list) or not segment_id:
            return
        with self.lock:
            for resolution in resolutions:
                if not isinstance(resolution, dict):
                    continue
                item = self.items.get(resolution.get("supplementId"))
                status = resolution.get("status")
                if item and item["status"] == "applied" and status in ("addressed", "needs_clarification", "failed"):
                    item["responseSegmentId"] = segment_id
                    self.emit(item, status, responseSegmentId=segment_id)

    def finish_or_continue(self, result):
        with self.lock:
            pending = [item for item in self.items.values() if item["status"] == "accepted"]
            if self.cancelled() or result.get("interrupted") or result.get("error") or result.get("failed"):
                for item in pending:
                    self.emit(item, "cancelled" if self.cancelled() or result.get("interrupted") else "pending")
                self.open = False
                return ""
            if pending:
                if any(item.get("continuationSent") for item in pending):
                    for item in pending:
                        self.emit(item, "pending")
                    result.update(completed=False, failed=True, error="supplement_delivery_unconfirmed")
                    self.open = False
                    return ""
                for item in pending:
                    item["continuationSent"] = True
                return "\n\n".join(item["nativeText"] for item in pending)
            self.open = False
            self.record["pendingSupplementIds"] = [item["id"] for item in self.items.values()
                if item["status"] != "addressed"]
            self.checkpoint(self.record)
            return ""


def bind_supplements(agent, channel):
    previous = agent._build_api_kwargs
    had_own = "_build_api_kwargs" in agent.__dict__
    previous_drain = getattr(agent, "_drain_pending_redirect", None)
    had_drain = "_drain_pending_redirect" in agent.__dict__
    previous_steer = getattr(agent, "steer", None)
    had_steer = "steer" in agent.__dict__

    def steer(text):
        with channel.lock:
            if any(item["status"] == "accepted" and item["nativeText"] == text
                   for item in channel.items.values()):
                return False
        return previous_steer(text)

    def drain():
        with channel.lock:
            native = previous_drain() if callable(previous_drain) else ""
            boundary = channel.drain_boundary()
            return "\n\n".join(text for text in (native, boundary) if text) or None

    def build(messages, *args, **kwargs):
        request = previous(messages, *args, **kwargs)
        channel.observe_request(request.get("messages", request.get("input", messages)))
        return request

    agent._build_api_kwargs = build
    agent._drain_pending_redirect = drain
    if callable(previous_steer):
        agent.steer = steer
    agent._baiqiu_supplements = channel

    def restore():
        with channel.lock:
            channel.open = False
        if agent._build_api_kwargs is build:
            if had_own:
                agent._build_api_kwargs = previous
            else:
                del agent._build_api_kwargs
        if agent._drain_pending_redirect is drain:
            if had_drain:
                agent._drain_pending_redirect = previous_drain
            else:
                del agent._drain_pending_redirect
        if getattr(agent, "steer", None) is steer:
            if had_steer:
                agent.steer = previous_steer
            else:
                del agent.steer
        if getattr(agent, "_baiqiu_supplements", None) is channel:
            del agent._baiqiu_supplements

    return restore
