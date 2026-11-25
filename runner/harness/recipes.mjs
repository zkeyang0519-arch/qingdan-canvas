import { digest } from "./task-store.mjs";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function visitTemplate(value, lookup, depth = 0) {
  if (depth > 12) throw Error("组合参数嵌套过深。");
  if (Array.isArray(value))
    return value.map((item) => visitTemplate(item, lookup, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "$input") || Object.hasOwn(value, "$step")) {
    if (
      Object.keys(value).some(
        (key) => !["$input", "$step", "path"].includes(key),
      ) ||
      (Object.hasOwn(value, "$input") && Object.hasOwn(value, "$step"))
    )
      throw Error("无效的组合参数引用。");
    if (
      value.path !== undefined &&
      (!Array.isArray(value.path) ||
        value.path.length > 10 ||
        value.path.some((key) => typeof key !== "string" || forbidden.has(key)))
    )
      throw Error("组合输出字段路径无效。");
    return lookup(value);
  }
  if (Object.keys(value).some((key) => forbidden.has(key)))
    throw Error("组合参数包含不允许的字段。");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      visitTemplate(item, lookup, depth + 1),
    ]),
  );
}

export function validateRecipe(args, known) {
  if (JSON.stringify(args).length > 20000) throw Error("工具组合过大。");
  const inputs = new Map(args.inputs.map((input) => [input.name, input]));
  if (
    inputs.size !== args.inputs.length ||
    args.inputs.some((input) => forbidden.has(input.name))
  )
    throw Error("组合输入名称重复或无效。");
  const steps = new Set();
  for (const step of args.steps) {
    if (steps.has(step.id) || forbidden.has(step.id))
      throw Error("组合步骤名称重复或无效。");
    if (
      !known.some(
        (tool) =>
          tool.name === step.tool && tool.state === "ready" && !tool.recipe,
      )
    )
      throw Error("组合只能使用当前项目已授权且可用的基础工具：" + step.tool);
    visitTemplate(step.args, (ref) => {
      if (Object.hasOwn(ref, "$input") && !inputs.has(ref.$input))
        throw Error("组合引用了不存在的输入。");
      if (Object.hasOwn(ref, "$step") && !steps.has(ref.$step))
        throw Error("组合只能引用前面步骤的输出。");
      return null;
    });
    steps.add(step.id);
  }
  return {
    ...args,
    name: "qd_recipe_" + args.name,
    version: digest(args),
    validation: "schema_checked",
  };
}

export function recipeSpec(recipe) {
  return {
    name: recipe.name,
    label: recipe.description.slice(0, 60),
    description: recipe.description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: recipe.inputs.map((input) => input.name),
      properties: Object.fromEntries(
        recipe.inputs.map((input) => [
          input.name,
          { type: input.type, description: input.description },
        ]),
      ),
    },
  };
}

export async function executeRecipe(recipe, args, invoke) {
  if (
    Object.keys(args).some(
      (key) => !recipe.inputs.some((input) => input.name === key),
    ) ||
    recipe.inputs.some((input) => typeof args[input.name] !== input.type)
  )
    throw Error("组合输入类型或字段不匹配。");
  const results = new Map();
  for (const step of recipe.steps) {
    const values = visitTemplate(step.args, (ref) => {
      let result = Object.hasOwn(ref, "$input")
        ? args[ref.$input]
        : results.get(ref.$step);
      for (const key of ref.path || []) {
        if (
          !result ||
          typeof result !== "object" ||
          !Object.hasOwn(result, key)
        )
          throw Error("组合所需的上一步结果字段不存在。");
        result = result[key];
      }
      if (result === undefined) throw Error("组合参数引用未获得结果。");
      return result;
    });
    const result = await invoke(step.tool, values, step.id);
    if (result?.isError)
      throw Error("组合步骤失败，后续步骤尚未执行：" + step.id);
    results.set(step.id, result);
  }
  return { steps: Object.fromEntries(results), validation: "executed" };
}
