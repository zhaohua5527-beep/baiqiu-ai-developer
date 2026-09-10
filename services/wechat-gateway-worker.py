"""Small JSON-line bridge for HMS 0.20.0's native Weixin adapter."""

import asyncio
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from gateway.platforms import weixin


def _emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _home():
    return str(Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").resolve())


def _accounts():
    root = Path(_home()) / "weixin" / "accounts"
    if not root.exists():
        return []
    values = []
    for item in root.glob("*.json"):
        if item.name.endswith(".context-tokens.json"):
            continue
        try:
            data = json.loads(item.read_text(encoding="utf-8"))
        except Exception:
            continue
        account_id = item.stem
        if data.get("token"):
            values.append((account_id, data))
    return values


def _history_messages(limit=500):
    database = Path(_home()) / "state.db"
    if not database.exists():
        return []
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True, timeout=3)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT m.id AS message_id, m.session_id, m.role, m.content, m.timestamp,
                   s.chat_id, s.user_id
              FROM messages AS m
              JOIN sessions AS s ON s.id = m.session_id
             WHERE s.source = 'weixin'
               AND m.role IN ('user', 'assistant')
               AND TRIM(COALESCE(m.content, '')) <> ''
               AND COALESCE(m.active, 1) = 1
             ORDER BY m.timestamp DESC, m.id DESC
             LIMIT ?
            """,
            (max(1, min(2000, int(limit or 500))),),
        ).fetchall()
    finally:
        connection.close()
    return [
        {
            "messageId": str(row["message_id"]),
            "sessionId": str(row["session_id"] or ""),
            "role": str(row["role"] or ""),
            "text": str(row["content"] or ""),
            "timestamp": float(row["timestamp"] or 0),
            "chatId": str(row["chat_id"] or ""),
            "userId": str(row["user_id"] or ""),
        }
        for row in reversed(rows)
    ]


async def _api_get(base_url, endpoint):
    async with weixin.aiohttp.ClientSession(trust_env=True, connector=weixin._make_ssl_connector()) as session:
        return await weixin._api_get(session, base_url=base_url, endpoint=endpoint, timeout_ms=weixin.QR_TIMEOUT_MS)


class Bridge:
    def __init__(self):
        self.qr_value = ""
        self.qr_base_url = weixin.ILINK_BASE_URL
        self.gateway = None
        self.gateway_reader = None
        self.send_cooldowns = {}
        self.desktop_receipts = {}

    async def relay_gateway_events(self, stream):
        prefix = b"__BAIQIU_WECHAT_EVENT__"
        while True:
            line = await stream.readline()
            if not line:
                return
            if not line.startswith(prefix):
                continue
            try:
                event = json.loads(line[len(prefix):].decode("utf-8"))
            except Exception:
                continue
            if event.get("type") == "desktop_receipt":
                pending = self.desktop_receipts.get(event.get("requestId"))
                if pending and not pending.done():
                    pending.set_result(event.get("result") or {})
                continue
            _emit({"type": "event", "event": event})

    async def ensure_gateway_started(self, account_id, data):
        if self.gateway and self.gateway.returncode is None:
            return True
        user_id = str(data.get("user_id") or "")
        if not account_id or not data.get("token") or not user_id:
            return False
        env = dict(os.environ)
        env.update({
            "HERMES_HOME": _home(),
            "PYTHONUTF8": "1",
            "WEIXIN_ACCOUNT_ID": account_id,
            "WEIXIN_TOKEN": str(data.get("token") or ""),
            "WEIXIN_BASE_URL": str(data.get("base_url") or weixin.ILINK_BASE_URL),
            "WEIXIN_DM_POLICY": "allowlist",
            "WEIXIN_ALLOWED_USERS": user_id,
            "WEIXIN_GROUP_POLICY": "disabled",
        })
        self.gateway = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).with_name("wechat-gateway-runtime.py")),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.gateway_reader = asyncio.create_task(self.relay_gateway_events(self.gateway.stdout))
        await asyncio.sleep(0.8)
        return self.gateway.returncode is None

    async def stop_gateway(self):
        process = self.gateway
        reader = self.gateway_reader
        self.gateway = None
        self.gateway_reader = None
        if not process or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        if reader and not reader.done():
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass

    async def handle(self, request):
        action = str(request.get("action") or "")
        if action == "qr":
            response = await _api_get(
                weixin.ILINK_BASE_URL,
                f"{weixin.EP_GET_BOT_QR}?bot_type=3",
            )
            self.qr_value = str(response.get("qrcode") or "")
            scan_data = str(response.get("qrcode_img_content") or self.qr_value)
            self.qr_base_url = weixin.ILINK_BASE_URL
            if not self.qr_value or not scan_data:
                return {"ok": False, "available": True, "reason": "微信二维码接口没有返回扫码内容"}
            return {"ok": True, "available": True, "qrText": scan_data, "qrValue": self.qr_value, "expiresInSeconds": 480}
        if action == "qr-status":
            if not self.qr_value:
                return {"ok": False, "connected": False, "available": True, "reason": "请先刷新二维码"}
            response = await _api_get(
                self.qr_base_url,
                f"{weixin.EP_GET_QR_STATUS}?qrcode={self.qr_value}",
            )
            status = str(response.get("status") or "wait")
            if status == "scaned_but_redirect" and response.get("redirect_host"):
                self.qr_base_url = f"https://{response['redirect_host']}"
            if status == "confirmed":
                account_id = str(response.get("ilink_bot_id") or "")
                token = str(response.get("bot_token") or "")
                base_url = str(response.get("baseurl") or weixin.ILINK_BASE_URL)
                user_id = str(response.get("ilink_user_id") or "")
                if not account_id or not token:
                    return {"ok": False, "connected": False, "available": True, "reason": "微信扫码已确认，但账号凭据不完整"}
                weixin.save_weixin_account(_home(), account_id=account_id, token=token, base_url=base_url, user_id=user_id)
                running = await self.ensure_gateway_started(account_id, {"token": token, "base_url": base_url, "user_id": user_id})
                return {"ok": running, "connected": running, "available": True, "accountId": account_id, "chatId": user_id, "reason": "微信已连接" if running else "微信账号已绑定，但 HMS 消息网关启动失败"}
            return {"ok": True, "connected": False, "available": True, "qrStatus": status, "reason": {"wait": "请使用微信扫码绑定黑球", "scaned": "已扫码，请在微信中确认", "expired": "二维码已过期，请刷新"}.get(status, f"微信扫码状态：{status}")}
        if action == "status":
            accounts = _accounts()
            if not accounts:
                return {"ok": True, "connected": False, "available": True, "reason": "请刷新二维码后使用微信扫码绑定黑球"}
            account_id, data = accounts[0]
            running = await self.ensure_gateway_started(account_id, data)
            return {"ok": running, "connected": running, "available": True, "accountId": account_id, "chatId": str(data.get("user_id") or ""), "updatedAt": data.get("saved_at") or "", "reason": "微信已连接" if running else "微信账号已绑定，但 HMS 消息网关没有运行"}
        if action == "history":
            return {"ok": True, "available": True, "messages": _history_messages(request.get("limit") or 500)}
        if action == "unbind":
            await self.stop_gateway()
            root = Path(_home()) / "weixin" / "accounts"
            removed = 0
            for account_id, _data in _accounts():
                for item in root.glob(f"{account_id}*"):
                    if item.is_file():
                        item.unlink(missing_ok=True)
                        removed += 1
            self.qr_value = ""
            return {"ok": True, "connected": False, "available": True, "unbound": removed > 0}
        if action == "send":
            accounts = _accounts()
            if not accounts:
                return {"ok": False, "reason": "微信尚未连接，请先扫码"}
            account_id, data = accounts[0]
            if not await self.ensure_gateway_started(account_id, data):
                return {"ok": False, "reason": "微信消息网关启动失败"}
            request_id = str(request.get("id") or "")
            future = asyncio.get_running_loop().create_future()
            self.desktop_receipts[request_id] = future
            try:
                self.gateway.stdin.write((json.dumps({"id": request_id, "message": request.get("message")}, ensure_ascii=False) + "\n").encode("utf-8"))
                await self.gateway.stdin.drain()
                return await asyncio.wait_for(future, timeout=30)
            except asyncio.TimeoutError:
                return {"ok": False, "reason": "暂未收到网关接收确认，请先查看会话记录，避免重复提交"}
            finally:
                self.desktop_receipts.pop(request_id, None)
        if action == "deliver":
            accounts = _accounts()
            if not accounts:
                return {"ok": False, "connected": False, "available": True, "reason": "微信尚未连接"}
            account_id, data = accounts[0]
            remaining = math.ceil(self.send_cooldowns.get(account_id, 0) - time.monotonic())
            if remaining > 0:
                return {
                    "ok": False, "connected": True, "code": "WECHAT_SEND_RATE_LIMITED",
                    "retryAfterSeconds": remaining,
                    "reason": f"微信接口拒绝发送，客户端冷却还剩 {remaining} 秒；草稿已保留，请稍后手动重试",
                }
            chat_id = str(request.get("chatId") or data.get("user_id") or "")
            message = str(request.get("message") or "").strip()
            if not chat_id or not message:
                return {"ok": False, "reason": "微信消息缺少会话或内容"}
            result = await weixin.send_weixin_direct(
                extra={"account_id": account_id, "base_url": data.get("base_url") or weixin.ILINK_BASE_URL},
                token=str(data.get("token") or ""),
                chat_id=chat_id,
                message=message,
            )
            error = str(result.get("error") or "")
            cooldown = re.search(r"cooldown active for ([0-9]+(?:\.[0-9]+)?)s", error)
            if not result.get("success") and cooldown:
                remaining = max(1, math.ceil(float(cooldown.group(1))))
                self.send_cooldowns[account_id] = time.monotonic() + remaining
                return {
                    "ok": False, "connected": True, "code": "WECHAT_SEND_RATE_LIMITED",
                    "retryAfterSeconds": remaining,
                    "reason": f"微信接口返回限流，客户端暂停发送 {remaining} 秒；草稿已保留，请稍后手动重试",
                }
            return {"ok": bool(result.get("success")), "connected": True, "messageId": result.get("message_id"), "reason": error}
        return {"ok": False, "reason": f"未知微信桥接命令：{action}"}


async def main():
    bridge = Bridge()
    _emit({"type": "ready", "version": "hms-weixin-0.20.0"})
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = {}
            try:
                request = json.loads(line)
                result = await bridge.handle(request)
            except Exception as error:
                result = {"ok": False, "reason": str(error)[:240]}
            _emit({"id": request.get("id", "") if isinstance(request, dict) else "", "result": result})
    finally:
        await bridge.stop_gateway()


if __name__ == "__main__":
    asyncio.run(main())
