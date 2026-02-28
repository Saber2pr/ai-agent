import { z } from "zod";

import { GraphAgentOptions, ToolInfo } from "../types/type";

export interface CreateToolOptions {
  name: string;
  description: string;
  /**
   * zod@3.25
   */
  parameters: z.ZodObject<any>;
  handler: (
    args: any,
    context: { allTools: ToolInfo[]; agentOptions?: GraphAgentOptions },
  ) => Promise<string>;
}

export function createTool(options: CreateToolOptions): ToolInfo {
  return {
    type: "function",
    function: {
      name: options.name,
      description: options.description,
      parameters: options.parameters,
    },
    _handler: async (input, context) => {
      // 兼容处理：如果 input 是字符串，尝试解析为 JSON 对象
      let args = input;
      if (typeof input === "string") {
        try {
          args = JSON.parse(input);
        } catch {
          args = input;
        }
      }

      return options.handler(args, context);
    },
  };
}
