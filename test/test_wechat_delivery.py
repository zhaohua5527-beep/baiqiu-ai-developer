import asyncio
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

services = Path(__file__).resolve().parents[1] / "services"
sys.path.insert(0, str(services))
from baiqiu_wechat_messages import read_messages, start_capture, store_message
from baiqiu_windows_process import bounded_probe, install_windows_probe_guard


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, services / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load("wechat_worker_test", "wechat-gateway-worker.py")
runtime = load("wechat_runtime_test", "wechat-gateway-runtime.py")


class WechatDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="baiqiu-wechat-test-")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        environment = patch.dict(os.environ, {"HERMES_HOME": str(self.root),
            "WEIXIN_ALLOWED_USERS": "fixture-user", "HERMES_GATEWAY_BUSY_INPUT_MODE": "queue",
            "HERMES_GATEWAY_BUSY_TEXT_MODE": "queue"})
        environment.start()
        self.addCleanup(environment.stop)

    def test_journal_replay_is_idempotent_without_merging_repeated_text(self):
        start_capture()
        first = {"chatId": "fixture", "role": "user", "messageId": "1", "text": "继续"}
        store_message(first)
        store_message(first)
        store_message({**first, "messageId": "2"})
        page = read_messages(0, 1)
        self.assertEqual(len(page["messages"]), 1)
        self.assertTrue(page["messages"][0]["journal"])
        second = read_messages(page["cursor"])
        self.assertEqual(second["messages"][0]["messageId"], "2")
        self.assertEqual(read_messages(second["cursor"])["messages"], [])
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            store_message({**first, "text": "不能覆盖"})
        self.assertEqual(read_messages()["messages"][0]["text"], "继续")

    def test_journal_connection_is_closed(self):
        from baiqiu_wechat_messages import open_store
        with open_store() as connection:
            connection.execute("SELECT 1")
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")

    def test_legacy_document_preserves_caption_and_rejects_external_path(self):
        document_dir = self.root / "cache" / "documents"
        document_dir.mkdir(parents=True)
        attachments = []
        notices = []
        for name in ("合同.docx", "owner's notes.pdf"):
            document = document_dir / name
            document.write_bytes(b"fixture")
            attachments.append(document)
            notices.append(f"[The user sent a document: '{name}'. It is saved at: {document}. Its text is not inlined here (it's a binary format such as PDF or DOCX). To read it, extract text instead of asking the user to paste the contents.]")
        content = "请比较两份附件。\n" + "\n".join(notices) + "\n保留总结。"
        text, files = worker._legacy_document_attachments(content)
        self.assertIn("请比较两份附件。", text)
        self.assertIn("保留总结。", text)
        self.assertEqual([item["name"] for item in files], [item.name for item in attachments])
        outside = self.root / "private.txt"
        outside.write_text("fixture")
        forged = notices[0].replace(str(attachments[0]), str(outside))
        self.assertEqual(worker._legacy_document_attachments(forged), (forged, []))

    def test_mixed_media_names_and_missing_message_id(self):
        image = self.root / "photo.png"
        document = self.root / "doc_random_合同.docx"
        image.write_bytes(b"image")
        document.write_bytes(b"document")
        event = SimpleNamespace(source=SimpleNamespace(chat_id="fixture", user_id="fixture-user"),
            message_id="", timestamp=datetime.now(), media_urls=[str(image), str(document)],
            media_types=["image/png", "application/octet-stream"],
            raw_message={"item_list": [{"image_item": {}}, {"file_item": {"file_name": "合同.docx"}}]})
        result = runtime._event_payload(event, "user", "")
        self.assertEqual([item["name"] for item in result["attachments"]], ["photo.png", "合同.docx"])
        self.assertTrue(result["messageId"])
        self.assertEqual(runtime._event_payload(event, "user", "")["messageId"], result["messageId"])

    async def test_busy_attachment_is_mirrored_then_drained_without_interrupt(self):
        from gateway.config import PlatformConfig
        from gateway.platforms.base import MessageEvent, MessageType
        adapter = runtime.WeixinAdapter(PlatformConfig(enabled=True, token="fixture-token", typing_indicator=False,
            extra={"account_id": "fixture-account", "dm_policy": "allowlist", "allowed_users": ["fixture-user"]}))
        adapter._is_dm_allowed = lambda user: user == "fixture-user"
        adapter._busy_text_mode = runtime.GatewayRunner._load_busy_text_mode()
        self.assertEqual(adapter._busy_text_mode, "queue")
        self.assertEqual(runtime.GatewayRunner._load_busy_input_mode(), "queue")
        started = asyncio.Event()
        release = asyncio.Event()
        done = asyncio.Event()
        seen = []

        async def handler(event):
            seen.append(event.message_id)
            if event.message_id == "first":
                started.set()
                await release.wait()
            else:
                done.set()
            return ""

        adapter._message_handler = handler
        adapter.send_typing = AsyncMock()
        source = adapter.build_source(chat_id="fixture-user", chat_type="dm", user_id="fixture-user")
        first = MessageEvent(text="执行第一件事", source=source, message_id="first", message_type=MessageType.TEXT)
        document = self.root / "attachment.docx"
        document.write_bytes(b"fixture")
        followup = MessageEvent(text="", source=source, message_id="followup", message_type=MessageType.DOCUMENT,
            media_urls=[str(document)], media_types=["application/octet-stream"])
        with patch.object(runtime.sys, "stdout", io.StringIO()):
            await adapter.handle_message(first)
            await asyncio.wait_for(started.wait(), 2)
            await adapter.handle_message(followup)
            self.assertEqual(seen, ["first"])
            self.assertFalse(any(guard.is_set() for guard in adapter._active_sessions.values()))
            self.assertEqual([item["messageId"] for item in read_messages()["messages"]], ["first", "followup"])
            release.set()
            await asyncio.wait_for(done.wait(), 2)
            await asyncio.sleep(0)
        self.assertEqual(seen, ["first", "followup"])

    async def test_successful_send_is_not_retried_when_journal_fails(self):
        send = AsyncMock(return_value=SimpleNamespace(success=True, message_id="outbound"))
        with patch.object(runtime, "_original_send", send), patch.object(runtime, "store_message", side_effect=OSError("fixture")), \
                patch.object(runtime.sys, "stdout", io.StringIO()), self.assertLogs(runtime.__name__, level="ERROR"):
            result = await runtime._send_with_chinese_notice(object(), "fixture", "阶段性结果")
        self.assertTrue(result.success)
        send.assert_awaited_once()

    async def test_sent_file_survives_temporary_source_removal(self):
        document = self.root / "result.docx"
        document.write_bytes(b"fixture")
        with patch.object(runtime, "_original_send_file", AsyncMock(return_value="file-sent")), patch.object(runtime.sys, "stdout", io.StringIO()):
            await runtime._send_file_with_mirror(object(), "fixture", str(document), "结果附件")
        document.unlink()
        item = read_messages()["messages"][0]
        self.assertEqual(item["text"], "结果附件")
        self.assertEqual(Path(item["attachments"][0]["path"]).read_bytes(), b"fixture")

    async def test_repeated_unbind_fresh_qr_and_retry_after_failure(self):
        bridge = worker.Bridge()
        responses = AsyncMock(side_effect=[{"qrcode": "first"}, OSError("fixture network failure"), {"qrcode": "second"}])
        with patch.object(worker, "_api_get", responses), patch.object(worker, "_accounts", return_value=[]):
            await bridge.handle({"action": "unbind"})
            self.assertEqual((await bridge.handle({"action": "qr"}))["qrText"], "first")
            bridge.qr_base_url = "https://old-redirect.invalid"
            await bridge.handle({"action": "unbind"})
            self.assertEqual(bridge.qr_value, "")
            self.assertEqual(bridge.qr_base_url, worker.weixin.ILINK_BASE_URL)
            with self.assertRaises(OSError):
                await bridge.handle({"action": "qr"})
            self.assertEqual((await bridge.handle({"action": "qr"}))["qrText"], "second")

    async def test_gateway_readiness_requires_adapter_confirmation(self):
        bridge = worker.Bridge()
        ready = asyncio.get_running_loop().create_future()
        stream = asyncio.StreamReader()
        stream.feed_data(b'__BAIQIU_WECHAT_EVENT__{"type":"gateway_ready","connected":true}\n')
        stream.feed_eof()
        await bridge.relay_gateway_events(stream, ready)
        self.assertTrue(ready.result())
        closed = asyncio.StreamReader()
        closed.feed_eof()
        failed = asyncio.get_running_loop().create_future()
        await bridge.relay_gateway_events(closed, failed)
        self.assertFalse(failed.result())

    def test_bash_probe_times_out_with_inherited_child_output(self):
        child = "import time; time.sleep(3)"
        source = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(5)"
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            bounded_probe([sys.executable, "-c", source], timeout=0.15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertLess(time.monotonic() - started, 2.5)

    def test_native_probe_patch_and_successful_output(self):
        install_windows_probe_guard()
        install_windows_probe_guard()
        result = bounded_probe([sys.executable, "-c", "print('fixture-ok')"], timeout=2)
        self.assertEqual(result.stdout.strip(), "fixture-ok")
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
