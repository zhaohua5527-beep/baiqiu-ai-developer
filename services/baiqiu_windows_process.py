import os
import subprocess
import tempfile


def bounded_probe(args, *, timeout=15, creationflags=0, **kwargs):
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output,
            stderr=subprocess.STDOUT, creationflags=creationflags)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                try:
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        timeout=2, creationflags=subprocess.CREATE_NO_WINDOW)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            raise
        output.seek(0)
        text = output.read(8192).decode("utf-8", errors="replace")
        return subprocess.CompletedProcess(args, process.returncode, text, "")


def install_windows_probe_guard():
    if os.name != "nt":
        return
    from tools.environments import local
    from baiqiu_tool_execution import patch_function
    if getattr(local, "_baiqiu_bounded_probe_installed", False):
        return
    patched = patch_function(local._bash_starts, "result = subprocess.run(", "result = _baiqiu_bounded_probe(")
    local._baiqiu_bounded_probe = bounded_probe
    local._bash_starts = patched
    local._baiqiu_bounded_probe_installed = True
