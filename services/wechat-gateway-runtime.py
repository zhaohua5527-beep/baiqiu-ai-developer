"""Run HMS GatewayRunner while mirroring Weixin turns to the desktop bridge."""

import asyncio
import contextvars
import json
import os
import sys
from datetime import datetime
from uuid import uuid4

from gateway.platforms.weixin import WeixinAdapter
from gateway.platforms.base import MessageEvent, MessageType
from gateway.run import GatewayRunner, main
from baiqiu_async_delivery import install_gateway_delivery_guard


PREFIX = "__BAIQIU_WECHAT_EVENT__"
_original_set_message_handler = WeixinAdapter.set_message_handler
_original_send = WeixinAdapter.send
_notice_scope = contextvars.ContextVar("baiqiu_wechat_notice", default=False)
_desktop_reader = None


def chinese_wechat_notice(content):
    if content.startswith("📬 No home channel is set for Weixin."):
        return "📬 尚未设置默认通知会话。可发送 /sethome，让当前微信会话接收定时任务结果和跨平台消息；也可以暂时跳过。"
    messages = {
        "⚡ Interrupting current task": "⚡ 正在中断当前任务，随后处理你的新消息。",
        "⏩ Steered into current run": "⏩ 已补充到当前任务，下次工具调用后会处理。",
        "↪ Redirected current run": "↪ 已收到更正，正在调整当前任务。",
        "⏳ Subagent working": "⏳ 子任务正在执行，新消息已排队。可发送 /stop 终止任务。",
        "⏳ Compressing context": "⏳ 正在整理上下文，新消息已排队。可发送 /stop 终止任务。",
        "⏳ Queued for the next turn": "⏳ 新消息已排队，当前任务结束后回复。",
    }
    for prefix, translated in messages.items():
        if content.startswith(prefix):
            if "First-time tip" in content:
                translated += "\n\n💡 首次提示：/busy queue 可将后续消息排队，/busy steer 可在任务中补充要求，/busy interrupt 可中断当前任务，/busy status 可查看当前方式。"
            return translated
    return content


async def _send_with_chinese_notice(self, chat_id, content, *args, **kwargs):
    if _notice_scope.get():
        content = chinese_wechat_notice(content)
    return await _original_send(self, chat_id, content, *args, **kwargs)


def _with_notice_scope(handler):
    async def scoped(self, *args, **kwargs):
        token = _notice_scope.set(True)
        try:
            return await handler(self, *args, **kwargs)
        finally:
            _notice_scope.reset(token)
    return scoped


async def _read_desktop_messages(adapter):
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            return
        request = {}
        try:
            request = json.loads(line)
            text = str(request.get("message") or "").strip()
            user_id = os.environ.get("WEIXIN_ALLOWED_USERS", "").strip()
            if not text or not user_id:
                raise ValueError("微信消息内容或绑定用户缺失")
            for attempt in range(100):
                if getattr(adapter, "_send_session", None) is not None:
                    break
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError("微信网关尚未就绪，请稍后重试")
            event = MessageEvent(
                text=text, message_type=MessageType.TEXT,
                source=adapter.build_source(chat_id=user_id, chat_type="dm", user_id=user_id, user_name=user_id),
                raw_message={"desktop": True}, message_id=f"desktop:{uuid4()}", timestamp=datetime.now(),
            )
            await adapter.handle_message(event)
            result = {"ok": True, "accepted": True, "messageId": event.message_id}
        except Exception as error:
            result = {"ok": False, "reason": str(error)[:240]}
        _emit_event({"type": "desktop_receipt", "requestId": request.get("id", ""), "result": result})


def _event_payload(event, role, text):
    source = getattr(event, "source", None)
    message_id = str(getattr(event, "message_id", "") or "")
    return {
        "role": role,
        "text": str(text or ""),
        "messageId": message_id if role == "user" else (f"reply:{message_id}" if message_id else ""),
        "chatId": str(getattr(source, "chat_id", "") or ""),
        "userId": str(getattr(source, "user_id", "") or ""),
    }


def _emit_event(payload):
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _set_message_handler_with_mirror(self, handler):
    global _desktop_reader
    async def mirrored(event):
        text = str(getattr(event, "text", "") or "").strip()
        if text:
            _emit_event(_event_payload(event, "user", text))
        response = await handler(event)
        if isinstance(response, str) and response.strip():
            _emit_event(_event_payload(event, "assistant", response.strip()))
        return response

    result = _original_set_message_handler(self, mirrored)
    if _desktop_reader is None or _desktop_reader.done():
        _desktop_reader = asyncio.get_running_loop().create_task(_read_desktop_messages(self))
    return result


WeixinAdapter.set_message_handler = _set_message_handler_with_mirror
install_gateway_delivery_guard(GatewayRunner)
WeixinAdapter.send = _send_with_chinese_notice
GatewayRunner._deliver_platform_notice = _with_notice_scope(GatewayRunner._deliver_platform_notice)
GatewayRunner._handle_active_session_busy_message = _with_notice_scope(GatewayRunner._handle_active_session_busy_message)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    main()
