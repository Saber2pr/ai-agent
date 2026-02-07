import { Client } from '@modelcontextprotocol/sdk/client/index';
import { z } from 'zod';
import { AgentGraphModel } from '../model/AgentGraphModel';

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
    parameters: z.ZodObject<any>;
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
  tools?: ToolInfo[];
  extraSystemPrompt?: any;
  maxTokens?: number;
  verbose?: boolean
  apiConfig?: ApiConfig
}

export interface GraphAgentOptions extends AgentOptions {
  apiModel?: AgentGraphModel
  alwaysSystem?: boolean;
  recursionLimit?: number;
  maxTargetCount?: number
}