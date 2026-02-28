import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";

import { createTool } from "../../utils/createTool";
import { generateToolMarkdown } from "../../utils/generateToolMarkdown";
import { getArray } from "../../utils/kit";
import { getSystemPromptTemplate } from "../../utils/getSystemPromptTemplate";

export const getAllToolsSchema = createTool({
  name: "get_all_tools_schema",
  description:
    'Use this tool when you encounter a "tool not found" error or are unsure about the parameter schema. It retrieves the full definitions and JSON schemas for all available tools in the current environment.',
  parameters: z.object({
    toolName: z
      .string()
      .optional()
      .describe(
        "Optional: Specify a tool name to get its detailed schema. If omitted, returns all available tools.",
      ),
  }),
  // 增加第二个参数 context
  handler: async ({ toolName }, context) => {
    // 这里的 context.allTools 是在运行时从 Agent 实例传入的
    const availableTools = getArray(context?.allTools);

    const targetTools = toolName
      ? availableTools.filter((t) => t.function.name === toolName)
      : availableTools;

    let remainPrompt = "";
    if (context?.agentOptions) {
      // 如果AI忘记了工具用法，说明出现了记忆模糊，这里把系统提示词再补充上，加强记忆
      const systemPrompt = getSystemPromptTemplate(
        context.agentOptions.targetDir,
      );
      remainPrompt = `${systemPrompt || ""}\n${
        context?.agentOptions?.extraSystemPrompt || ""
      }`;
    }

    const toolsMarkdown = generateToolMarkdown(
      targetTools.map((item) => ({
        ...item,
        function: {
          ...item.function,
          parameters: zodToJsonSchema(item.function.parameters),
        },
      })),
    );

    return `${remainPrompt}\n${toolsMarkdown}`;
  },
});
