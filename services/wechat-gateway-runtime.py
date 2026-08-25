"""Run HMS GatewayRunner while mirroring Weixin turns to the desktop bridge."""

import json
import os
import sys

from gateway.platforms.weixin import WeixinAdapter


PREFIX = "__BAIQIU_WECHAT_EVENT__"
_original_set_message_handler = WeixinAdapter.set_message_handler


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
    async def mirrored(event):
        text = str(getattr(event, "text", "") or "").strip()
        if text:
            _emit_event(_event_payload(event, "user", text))
        response = await handler(event)
        if isinstance(response, str) and response.strip():
            _emit_event(_event_payload(event, "assistant", response.strip()))
        return response

    return _original_set_message_handler(self, mirrored)


WeixinAdapter.set_message_handler = _set_message_handler_with_mirror

from gateway.run import main


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    main()
