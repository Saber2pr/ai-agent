import { z } from 'zod';
import { createTool } from '../../utils/createTool';
import { getArray } from '../../utils/kit';
import { ToolInfo } from '../../types/type';

const formatOutput = (output: any): string => {
  // 1. 处理空值
  if (output === null || output === undefined) return String(output);

  // 2. 处理数组 (MCP 常见返回格式)
  if (Array.isArray(output)) {
    // 尝试提取所有 text 类型的 content 并合并，如果不是 MCP 格式则递归处理
    const isMcpStyle = output.every(item => item && typeof item === 'object' && 'type' in item);
    
    if (isMcpStyle) {
      return output
        .map(item => {
          if (item.type === 'text') return item.text;
          if (item.type === 'resource') return `[Resource: ${item.resource?.uri}]`;
          return JSON.stringify(item); // 无法识别的 MCP 类型（如 image）保持 JSON
        })
        .join('\n');
    }
    
    // 普通数组递归处理
    return output.map(item => formatOutput(item)).join('\n');
  }

  // 3. 处理单个对象
  if (typeof output === 'object') {
    // 处理单个 MCP 文本对象
    if (output.type === 'text' && typeof output.text === 'string') {
      return output.text;
    }
    // 其他对象转为格式化 JSON
    return JSON.stringify(output, null, 2);
  }

  // 4. 基本类型直接转 String
  return String(output);
};

export const batchRunTools = createTool({
  name: 'batch_run_tools',
  // 使用更具指令性的英文描述
  description: `Execute multiple read-only tools in parallel. Such as reading multiple files or fetching diagnostics simultaneously.`,
  parameters: z.object({
    actions: z.array(z.object({
      // 字段名和描述对齐 AI 习惯
      tool_name: z.string().describe('The name of the tool to execute.'),
      args: z.any().describe('The JSON object containing arguments for the specific tool.')
    })).describe('A list of tool-calling actions to be executed concurrently.')
  }),
  handler: async ({ actions }, context) => {
    // 1. 获取所有可用工具的映射
    const toolMap: Record<string, ToolInfo> = getArray(context?.allTools).reduce(
      (acc, tool) => ({ ...acc, [tool.function.name]: tool }), 
      {}
    ); 

    // 2. 预检：拦截并发写入行为
    const writeTools = actions.filter(action => /edit|write|replace|delete/i.test(action.tool_name));
    if (writeTools.length > 0) {
      return `Error: Parallel write operations detected (${writeTools.map(t => t.tool_name).join(', ')}). Batching is ONLY allowed for READ-ONLY operations.`;
    }
    
    if (Object.keys(toolMap).length === 0) {
      return 'Error: Failed to retrieve tool execution context.';
    }

    // 2. 并行执行所有 Action
    const results = await Promise.all(actions.map(async (action) => {
      const { tool_name, args } = action;
      const tool = toolMap[tool_name];

      if (!tool) {
        return {
          tool_name,
          status: 'error',
          output: `Tool not found: ${tool_name}`
        };
      }

      try {
        // 特别注意：这里调用的是 _handler，请确保参数 args 的结构与子工具 Zod 定义一致
        const output = await tool._handler(args, context);
        return {
          tool_name,
          status: 'success',
          output
        };
      } catch (error: any) {
        return {
          tool_name,
          status: 'error',
          output: error?.message || String(error)
        };
      }
    }));

    return results.map(res => 
      `### Tool: ${res.tool_name} (${res.status})\n${formatOutput(res.output)}\n---`
    ).join('\n');
  }
});