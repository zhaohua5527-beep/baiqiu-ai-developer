import faulthandler
import os
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path


def probe():
    faulthandler.dump_traceback_later(10)
    with tempfile.TemporaryDirectory(prefix="baiqiu-wechat-repro-") as fixture:
        os.environ["HERMES_HOME"] = fixture
        os.environ["TERMINAL_ENV"] = "local"
        os.environ["TERMINAL_CWD"] = fixture
        from tools.file_tools import read_file_tool
        document = Path(fixture) / "sample.docx"
        with zipfile.ZipFile(document, "w") as archive:
            archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>fixture</w:t></w:r></w:p></w:body></w:document>')
        started = time.monotonic()
        print("START fixture read_file", flush=True)
        result = read_file_tool(str(document))
        print("DONE", round(time.monotonic() - started, 3), result, flush=True)
        faulthandler.cancel_dump_traceback_later()


if __name__ == "__main__":
    if "--child" in sys.argv:
        probe()
    else:
        try:
            result = subprocess.run([sys.executable, __file__, "--child"], capture_output=True, text=True, timeout=20)
            print(result.stdout)
            print(result.stderr)
        except subprocess.TimeoutExpired as error:
            print("20s deadline reached")
            print(error.stdout)
            print(error.stderr)
