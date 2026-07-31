from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_system_prompt_v2_exists_and_declares_dual_mode_router():
    prompt = read("config/system_prompt_v2.md")
    assert "对话模式 chat" in prompt
    assert "执行模式 execute" in prompt
    assert "不注入 Task Brain 全量状态机" in prompt
    assert "历史对话" in prompt
    assert "元信息讨论授权" in prompt
    assert "不伪造执行结果" in prompt


def test_runtime_does_not_always_prefix_task_brain_prompt():
    main_js = read("main.js")
    assert "function classifyBaiqiuDialogMode" in main_js
    assert 'const executionText = dialogMode === "execute" && taskBrainPrompt' in main_js
    assert "const executionText = taskBrainPrompt ?" not in main_js


def test_feedback_and_correction_are_not_fixed_confirmation_replies():
    main_js = read("main.js")
    assert "已收到更正。我会采用修正后的上下文" not in main_js
    assert "我会先复述理解，再等待您确认" not in main_js


def test_analysis_router_uses_direct_analysis_prompt():
    router = read("services/response-router.js")
    assert "你正在进行对话模式下的直接分析" in router
    assert "不要套用“复述理解→请求确认→等待”的固定流程" in router
    assert "把它当作参考材料分析" in router
