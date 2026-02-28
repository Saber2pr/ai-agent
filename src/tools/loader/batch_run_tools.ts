import { z } from 'zod';
import { createTool } from '../../utils/createTool';
import { getArray } from '../../utils/kit';
import { ToolInfo } from '../../types/type';

export const batchRunTools = createTool({
  name: 'batch_run_tools',
  // 使用更具指令性的英文描述
  description: `Execute multiple tools in parallel. Use this for independent tasks such as reading multiple files, applying unrelated edits to different files, or fetching diagnostics simultaneously. CRITICAL: DO NOT apply multiple edits to the same file within a single batch to avoid write conflicts.`,
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

    // 3. 格式化输出结果
    // 虽然参数改成了英文，但返回给 AI 的结果标题可以保留清晰的结构
    return results.map(res => 
      `### Tool: ${res.tool_name} (${res.status})\n${res.output}\n---`
    ).join('\n');
  }
});