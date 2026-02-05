import { ToolInfo } from "../types/type";

export interface CreateToolOptions {
  name: string;
  description: string;
  parameters: any;
  handler: (args: any) => Promise<any>;
  maxTokens: number;
  getCurrentTokens: () => number;
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
      if (options.getCurrentTokens && options.maxTokens != null && options.getCurrentTokens() > options.maxTokens) {
        return `[SYSTEM WARNING]: Token 消耗已达上限，禁止获取详细方法体。请利用已获取的 Skeleton 信息进行分析。`;
      }

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
            if (typeof args[arg] !== "string" || args[arg].trim() === "") {
              return `Error: 参数 '${arg}' 无效。收到的是: ${JSON.stringify(args[arg])}`;
            }
          }
        }
      }

      return options.handler(args);
    },
  };
}