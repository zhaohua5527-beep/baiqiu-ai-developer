import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

from openai import OpenAI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services"))
from baiqiu_stage_delivery import progress_payloads
from baiqiu_protocol_recovery import protocol_fault


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))["settings"]["providers"]["deepseek"]
    if config["baseURL"].rstrip("/") != "https://api.deepseek.com/v1":
        raise ValueError("Affected provider endpoint changed; refusing a different destination")
    client = OpenAI(api_key=config["apiKey"], base_url=config["baseURL"], timeout=45, max_retries=0)
    request = ('隔离格式测试，数据均为虚构，不调用工具、不写文件。分两段交付：先用公开阶段结果给出表格，'
               '甲店库存100元，清仓20%，回收20元；乙店库存200元，回收40元。正文保留原文中的英文双引号：'
               '他说"按20%计价"。另给代码围栏展示路径 C:\\reports\\sample.txt。阶段结果后用普通最终正文写合计60元。')
    reports = []
    for name, module in (("before", Path(args.baseline)), ("after", root / "services/public-response-protocol.js")):
        prompt = subprocess.check_output(["node", "-e", "process.stdout.write(require(process.argv[1]).publicResponseStreamPrompt())", str(module)], cwd=root).decode("utf-8")
        started = time.monotonic()
        report = {"case": name, "provider": "deepseek", "model": config["model"], "requests": 1}
        content = ""
        reasoning_chars = 0
        try:
            with client.chat.completions.create(model=config["model"], messages=[{"role": "system", "content": prompt},
                    {"role": "user", "content": request}], stream=True, stream_options={"include_usage": True}, max_tokens=8192) as stream:
                for chunk in stream:
                    elapsed = round(time.monotonic() - started, 3)
                    report.setdefault("firstChunkSeconds", elapsed)
                    if chunk.usage:
                        report["usage"] = {"inputTokens": chunk.usage.prompt_tokens, "outputTokens": chunk.usage.completion_tokens}
                    for choice in chunk.choices:
                        reasoning_chars += len(getattr(choice.delta, "reasoning_content", None) or "")
                        delta = choice.delta.content or ""
                        if delta:
                            report.setdefault("firstPublicTextSeconds", elapsed)
                            content += delta
                            if progress_payloads(content):
                                report.setdefault("firstCompleteStageSeconds", elapsed)
                        if choice.finish_reason:
                            report["finishReason"] = choice.finish_reason
            stages = progress_payloads(content)
            report.update(seconds=round(time.monotonic() - started, 3), stageCount=len(stages),
                v2Stages=sum(stage.get("schemaVersion") == 2 for stage in stages),
                protocolFault=protocol_fault(content), publicChars=len(content), reasoningChars=reasoning_chars)
            report["passed"] = bool(stages) and not report["protocolFault"] and report.get("finishReason") == "stop"
        except Exception as error:
            report.update(passed=False, errorType=type(error).__name__, httpStatus=getattr(error, "status_code", None))
        reports.append(report)
        print(json.dumps(report, ensure_ascii=False), flush=True)
    Path(args.output).write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    if not reports[-1]["passed"] or not reports[-1].get("v2Stages"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
