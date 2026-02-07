import { ToolInfo } from '../types/type';
import { z } from 'zod';

export interface CreateToolOptions {
  name: string;
  description: string;
  /**
   * zod@3.25
   */
  parameters: z.ZodObject<any>;
  handler: (args: any) => Promise<string>;
}

export function createTool(options: CreateToolOptions): ToolInfo {
  return {
    type: "function",
    function: {
      name: options.name,
      description: options.description,
      parameters: options.parameters,
    },
    _handler: async input => {
      // 兼容处理：如果 input 是字符串，尝试解析为 JSON 对象
      let args = input;
      if (typeof input === 'string') {
        try {
          args = JSON.parse(input);
        } catch {
          args = input
        }
      }

      return options.handler(args);
    },
  };
}