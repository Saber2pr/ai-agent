import { z } from 'zod';

import { Client } from '@modelcontextprotocol/sdk/client/index';

import { AgentGraphModel } from '../model/AgentGraphModel';

// --- 类型定义 ---
export interface ApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ToolInfo {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: z.ZodObject<any>;
  };
  _handler?: (args: any, context: { allTools: ToolInfo[] }) => Promise<any>; // 内置工具处理器
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
  verbose?: boolean;
  apiConfig?: ApiConfig;
}

export interface GraphAgentOptions<T extends AgentGraphModel = any> extends AgentOptions {
  apiModel?: T;
  alwaysSystem?: boolean;
  recursionLimit?: number;
  /** 是否启用流式输出，默认 false */
  stream?: boolean;
}

export interface CreateAgentOptions {
  apiKey: string;
  apiUrl: string;
  targetDir?: string;
  /** 是否启用流式输出，默认 false */
  stream?: boolean;
  config?: GraphAgentOptions;
}