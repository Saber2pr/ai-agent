import { ToolInfo } from '../types/type';

export interface CreateToolOptions {
  name: string;
  description: string;
  parameters: any;
  handler: (args: any) => Promise<string>;
  validateParams?: string[]
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

      if (options.validateParams?.length > 0) {
        for (const arg in args) {
          if (options.validateParams.includes(arg)) {
            if (typeof args[arg] === 'undefined') {
              return `Error: 参数 '${arg}' 缺失`;
            }
          }
        }
      }

      return options.handler(args);
    },
  };
}