import { LLMModel } from '../adapters/llm';
import McpGraphAgent from '../core/agent-graph';
import { CreateAgentOptions } from '../types/type';

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