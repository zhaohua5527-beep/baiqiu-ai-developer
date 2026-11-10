import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_supplements import TurnSupplements, bind_supplements


class NativeAgent:
    api_mode = "chat_completions"

    def __init__(self):
        self.received = []
        self.running = True

    def redirect(self, text):
        if not self.running:
            return False
        self.received.append(text)
        return True

    def _build_api_kwargs(self, messages):
        return {"messages": messages}


class SupplementTests(unittest.TestCase):
    def setUp(self):
        self.agent = NativeAgent()
        self.events = []
        self.cancelled = False
        self.record = {"turnId": "turn"}
        self.channel = TurnSupplements(self.agent, self.record, self.events.append, lambda: self.cancelled)

    def test_same_identity_delivers_once_and_conflicting_text_is_rejected(self):
        self.assertEqual(self.channel.receive("one", "补充")["status"], "accepted")
        self.assertEqual(self.channel.receive("one", "补充")["status"], "accepted")
        self.assertEqual(len(self.agent.received), 1)
        with self.assertRaises(ValueError):
            self.channel.receive("one", "修改过的补充")

    def test_applied_requires_the_actual_built_request_and_restores_binding(self):
        restore = bind_supplements(self.agent, self.channel)
        self.channel.receive("one", "保留原任务")
        self.agent._build_api_kwargs([{"role": "user", "content": "原请求"}])
        self.assertEqual(self.record["supplements"]["one"]["status"], "accepted")
        self.agent._build_api_kwargs([{"role": "user", "content": self.agent.received[0]}])
        self.assertEqual([event["stage"] for event in self.events], ["accepted", "applied"])
        self.assertEqual(self.channel.finish_or_continue({"completed": True}), "")
        self.assertEqual(len({event["eventId"] for event in self.events}), 2)
        restore()
        self.assertNotIn("_build_api_kwargs", self.agent.__dict__)

    def test_completion_race_queues_until_the_native_channel_is_sealed(self):
        self.agent.running = False
        self.assertTrue(self.channel.receive("late", "补充")["accepted"])
        self.assertIn("补充", self.channel.finish_or_continue({"completed": True}))
        self.channel.open = False
        self.assertFalse(self.channel.receive("after-seal", "补充")["accepted"])
        self.assertTrue(self.channel.receive("late", "补充")["accepted"])

    def test_missing_delivery_has_only_one_same_turn_continuation(self):
        self.channel.receive("one", "不要丢失")
        result = {"completed": True}
        self.assertIn("不要丢失", self.channel.finish_or_continue(result))
        self.assertEqual(self.channel.finish_or_continue(result), "")
        self.assertFalse(result["completed"])
        self.assertEqual(result["error"], "supplement_delivery_unconfirmed")
        self.assertEqual(self.record["supplements"]["one"]["status"], "pending")

    def test_cancel_retains_unapplied_text_and_prevents_continuation(self):
        self.channel.receive("one", "保存这条补充")
        self.cancelled = True
        self.assertEqual(self.channel.finish_or_continue({"completed": True}), "")
        self.assertEqual(self.record["supplements"]["one"]["text"], "保存这条补充")
        self.assertEqual(self.record["supplements"]["one"]["status"], "cancelled")

    def test_notification_failure_does_not_lose_native_acceptance(self):
        def fail(event):
            raise OSError("notification unavailable")
        self.channel.publish = fail
        with self.assertLogs(level="WARNING"):
            self.assertTrue(self.channel.receive("one", "补充")["accepted"])
        self.assertEqual(len(self.agent.received), 1)
        self.assertEqual(self.record["supplements"]["one"]["status"], "accepted")

    def test_unsupported_engine_never_claims_acceptance(self):
        self.agent.api_mode = "codex_app_server"
        self.assertEqual(self.channel.receive("one", "补充")["status"], "unsupported")
        self.assertEqual(self.agent.received, [])


if __name__ == "__main__":
    unittest.main()
