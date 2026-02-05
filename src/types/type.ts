import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Client } from "@modelcontextprotocol/sdk/client/index";

// --- 类型定义 ---
export interface ApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ToolInfo {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any;
  };
  _handler?: (args: any) => Promise<any>; // 内置工具处理器
  _client?: Client; // 外部 MCP 客户端
  _originalName?: string;
}


export interface McpConfig {
  mcpServers: {
    [key: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

export interface AgentOptions {
  targetDir?: string;
  /** 外部传入的内置工具列表，不传则使用默认的 registerBuiltinTools */
  tools?: ToolInfo[];
  extraSystemPrompt?: any;
  maxTokens?: number;
  apiConfig?: ApiConfig
  apiModel?: BaseChatModel
  maxIterations?: number
  verbose?: boolean
}