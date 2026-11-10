import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_tool_execution import should_handoff_long_terminal


class SupplementToolHandoffTests(unittest.TestCase):
    def test_read_only_disk_scan_is_handed_off(self):
        self.assertTrue(should_handoff_long_terminal("du -sh /d/* 2>/dev/null | sort -hr", 600))

    def test_mutation_command_is_never_handed_off(self):
        self.assertFalse(should_handoff_long_terminal("du -sh /d/*; rm -rf /d/tmp", 600))

    def test_short_terminal_call_stays_foreground(self):
        self.assertFalse(should_handoff_long_terminal("ls -la", 30))


if __name__ == "__main__":
    unittest.main()
