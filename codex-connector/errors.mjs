export class ConnectorError extends Error {
  constructor(code, message, action = "重新检查") {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.action = action;
  }
}
export function problem(error) {
  if (error instanceof ConnectorError)
    return { code: error.code, message: error.message, action: error.action };
  if (["EACCES", "EPERM"].includes(error?.code))
    return {
      code: "ACCESS_DENIED",
      message: "系统拒绝访问程序或数据目录。",
      action: "检查访问权限",
    };
  return {
    code: "CONNECTOR_ERROR",
    message: "连接检查未完成，请重试或导出诊断。",
    action: "重新检查",
  };
}
export function invalid(message = "请求参数无效。") {
  return new ConnectorError("INVALID_INPUT", message, "检查输入");
}
