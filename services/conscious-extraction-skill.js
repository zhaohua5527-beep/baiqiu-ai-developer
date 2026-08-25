"use strict";

function clean(value, limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

class ConsciousExtractionSkill {
  extract(snapshot) {
    if (!snapshot || snapshot.type !== "conscious-snapshot") throw new Error("意识快照无效");
    const core = snapshot.core || {};
    const taskStates = snapshot.taskBrainState || [];
    const completedFromTasks = taskStates.filter((task) => task.status === "completed").flatMap((task) => task.completed?.length ? task.completed : [task.goal]);
    const pendingFromTasks = taskStates.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).flatMap((task) => task.pending?.length ? task.pending : [task.current_step || task.goal]);
    const completed = (core.completed_tasks?.length ? core.completed_tasks : completedFromTasks.length ? completedFromTasks : snapshot.completedTasks || []).slice(-20).map((item) => clean(item)).filter(Boolean);
    const pending = (core.pending_tasks?.length ? core.pending_tasks : pendingFromTasks.length ? pendingFromTasks : snapshot.pendingTasks || []).slice(0, 20).map((item) => clean(item)).filter(Boolean);
    const state = {
      projectGoal: clean(core.goal || snapshot.projectGoal || snapshot.title, 2000),
      currentTaskGoal: clean(core.goal || snapshot.currentTaskGoal || snapshot.projectGoal, 2000),
      currentStage: clean(core.current_stage || snapshot.currentProgress?.summary || snapshot.taskBrainState?.at(-1)?.current_stage || "已恢复", 500),
      completed,
      pending,
      agentStates: core.agent_state?.length ? core.agent_state : (snapshot.agentStates || []),
      taskBrainState: snapshot.taskBrainState || [],
      associatedFiles: core.important_files?.length ? core.important_files : (snapshot.fileChanges || []),
      workspaceState: snapshot.workspaceState || null
    };
    const report = [
      "老板，我已经恢复之前的工作状态。",
      "",
      `项目：${snapshot.projectName || snapshot.title || "当前工作"}`,
      `当前目标：${state.currentTaskGoal || state.projectGoal || "继续之前的工作"}`,
      "",
      "已完成：",
      ...(completed.length ? completed.map((item) => `✓ ${item}`) : ["暂无已完成记录"]),
      "",
      "下一步：",
      ...(pending.length ? pending.map((item) => `• ${item}`) : ["根据当前目标继续推进"]),
      "",
      "是否继续执行？"
    ].join("\n");
    return { state, report };
  }
}

module.exports = { ConsciousExtractionSkill };
