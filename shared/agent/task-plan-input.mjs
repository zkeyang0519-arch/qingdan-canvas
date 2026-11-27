import { CHAT_INPUT_LIMIT } from "./chat.ts";

export function taskPlanInput(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 50)
    throw Error("请选择 1 至 50 项待办。");
  const text =
    `请把以下 ${tasks.length} 项待办作为一个整体任务，先根据完成标准拆分子任务并生成任务卡，等我确认计划后再开始执行。\n\n` +
    tasks
      .map((task, index) => {
        if (typeof task.text !== "string" || !task.text.trim())
          throw Error("待办内容不完整，请刷新后重试。");
        return [
          `${index + 1}. ${task.text.trim()}`,
          task.instruction?.trim() && `执行要求：${task.instruction.trim()}`,
          task.acceptance?.trim() && `完成标准：${task.acceptance.trim()}`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  if (text.length > CHAT_INPUT_LIMIT)
    throw Error(
      "这批待办内容超过聊天长度上限，请减少所选项后再规划；原待办保持不变。",
    );
  return text;
}
