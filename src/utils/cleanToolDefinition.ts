/**
 * 清理工具定义：剔除外层包装和 parameters 内部的冗余元数据字段
 */
export function cleanToolDefinition(tool: any) {
  // 1. 提取核心 function 对象
  const fn = tool.function || tool;

  // 2. 解构 parameters，剔除不需要的 schema 描述字段
  const {
    $schema,
    additionalProperties,
    ...cleanParameters
  } = fn.parameters || {};

  // 3. 返回精简后的结构
  return {
    name: fn.name,
    description: fn.description,
    parameters: {
      type: cleanParameters.type || "object",
      properties: cleanParameters.properties || {},
      required: cleanParameters.required || []
    }
  };
}