import McpGraphAgent from '../core/agent-graph';
import { GraphAgentOptions } from '../types/type';
import { LLMModel } from '../adapters/llm';

export interface CreateAgentOptions {
  apiKey: string;
  apiUrl: string;
  targetDir?: string;
  /** 是否启用流式输出，默认 false */
  stream?: boolean;
  config?: GraphAgentOptions;
}

export const createAgent = (options: CreateAgentOptions): McpGraphAgent<LLMModel> => {
  const agent = new McpGraphAgent<LLMModel>({
    alwaysSystem: false,
    apiModel: new LLMModel(options),
    targetDir: options.targetDir,
    stream: options.stream, // ✅ 将 stream 选项透传到 McpGraphAgent
    ...(options?.config || {}),
  });
  return agent;
};

export type Agent = ReturnType<typeof createAgent>;