import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { cleanToolDefinition } from '../utils/cleanToolDefinition';
import { getArray } from '../utils/kit';

export interface AgentGraphLLMResponse {
  text: string;
  reasoning?: string;
  token?: number;
  duration?: number;
}

/** 流式输出的回调类型 */
export type StreamChunkCallback = (chunk: string) => void;

export abstract class AgentGraphModel extends BaseChatModel {
  protected boundTools?: any[];
  private mcpEnabled?: boolean = true
  private mcpTools?: any[] = []

  setMcpTools(tools: any[]) {
    this.mcpTools = tools
  }

  setMcpEnabled(enabled = true) {
    this.mcpEnabled = enabled
  }
  getMcpEnabled() {
    return this.mcpEnabled
  }
  getMcpTools() {
    return this.mcpTools
  }

  private isMcpTool(tool: any): boolean {
    const mcpTools = getArray(this.mcpTools)
    return mcpTools.some(t => t?.function?.name === tool?.function?.name)
  }

  constructor(fields?: BaseChatModelParams) {
    super(fields || {});
  }

  bindTools(tools: any[]): any {
    this.boundTools = tools.map(t => convertToOpenAITool(t));
    return this;
  }

  // 子类只需实现这个方法，返回 fetch 的配置或直接返回响应
  abstract callApi(prompt: string, lastMsg: BaseMessage): Promise<AgentGraphLLMResponse>;

  /**
   * 流式调用 API，子类可覆盖以实现真正的 SSE 流式传输。
   * 默认回退到 callApi 非流式调用。
   * @param prompt 序列化后的提示词
   * @param onChunk 每收到一段文本时的回调
   * @returns 完整的响应结果
   */
  async callApiStream(prompt: string, lastMsg: BaseMessage, onChunk: StreamChunkCallback): Promise<AgentGraphLLMResponse> {
    const result = await this.callApi(prompt, lastMsg);
    onChunk(result.text);
    return result;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const fullPrompt = this.serializeMessages(messages);
    const lastMsg = messages[messages.length - 1];
    const response = await this.callApi(fullPrompt, lastMsg);

    let { text, reasoning } = response;

    // 1. 处理思考内容
    if (!reasoning && text.includes('<think>')) {
      const match = text.match(/<think>([\s\S]*?)<\/think>/);
      if (match) {
        reasoning = match[1].trim();
        text = text.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      }
    }

    // 2. 解析工具调用
    const toolCalls = this.parseToolCalls(text);

    // AgentGraphModel.ts 的 _generate 方法内
    return {
      generations: [
        {
          text,
          message: new AIMessage({
            content: text,
            tool_calls: toolCalls,
            additional_kwargs: {
              reasoning: reasoning || '',
              token: response.token, // 👈 必须
              duration: response.duration, // 👈 必须
            },
            response_metadata: {
              reasoning: reasoning || '',
              token: response.token, // 👈 McpGraphAgent 读取路径
              duration: response.duration,
            },
          }),
        },
      ],
    };
  }

  private parseToolCalls(text: string) {
    const actionMatch = text.match(/Action:\s*(\w+)/);
    const argsMatch = text.match(/Arguments:\s*({[\s\S]*?})(?=\n|$)/);

    if (!actionMatch) return [];

    let args: any = {};
    if (argsMatch) {
      try {
        let raw = argsMatch[1].trim();

        // ✅ 关键修复：递归解析，直到它变成真正的对象
        // 这能处理 "\"{\\\"path\\\":...}\"" 这种套娃字符串
        let safetyDepth = 0;
        while (typeof raw === 'string' && safetyDepth < 5) {
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) {
              raw = parsed;
              break;
            }
            raw = parsed; // 如果解析后还是 string，继续剥
          } catch {
            break; // 解析不动了，跳出
          }
          safetyDepth++;
        }
        args = raw;
      } catch (e) {
        args = {};
      }
    }

    // ✅ 此时返回的 args 必须是 object 类型
    return [
      {
        name: actionMatch[1],
        args: typeof args === 'object' ? args : {},
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'tool_call' as const,
      },
    ];
  }

  /**
   * 流式生成：调用 callApiStream 进行流式输出，完成后构建完整的 ChatResult。
   * @param messages LangChain 消息列表
   * @param onChunk 每收到一段文本时的回调
   */
  async streamGenerate(messages: BaseMessage[], onChunk: StreamChunkCallback): Promise<ChatResult> {
    const fullPrompt = this.serializeMessages(messages);
    const lastMsg = messages[messages.length - 1];
    const response = await this.callApiStream(fullPrompt, lastMsg, onChunk);

    let { text, reasoning } = response;

    // 1. 处理思考内容
    if (!reasoning && text.includes('<think>')) {
      const match = text.match(/<think>([\s\S]*?)<\/think>/);
      if (match) {
        reasoning = match[1].trim();
        text = text.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      }
    }

    // 2. 解析工具调用
    const toolCalls = this.parseToolCalls(text);

    return {
      generations: [
        {
          text,
          message: new AIMessage({
            content: text,
            tool_calls: toolCalls,
            additional_kwargs: {
              reasoning: reasoning || '',
              token: response.token,
              duration: response.duration,
            },
            response_metadata: {
              reasoning: reasoning || '',
              token: response.token,
              duration: response.duration,
            },
          }),
        },
      ],
    };
  }

  public serializeMessages(messages: BaseMessage[]): string {
    const systemMsg = messages.find(m => m._getType() === 'system');
    const lastMsg = messages[messages.length - 1];

    const format = (m: BaseMessage) => {
      const content =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
      return `${m._getType().toUpperCase()}: ${content}`;
    };

    const tools = this.getMcpEnabled() ? getArray(this.boundTools) : getArray(this.boundTools).filter(tool => !this.isMcpTool(tool))
    const toolsContext = tools.length
      ? `\n[Tools]\n${JSON.stringify(tools.map(cleanToolDefinition), null, 2)}`
      : '';

    return `
${format(systemMsg as any)}
${toolsContext}
# Current Progress
${format(lastMsg)}
# Output Requirement
1. Reasoning in <think> tags.
2. Action: Name
3. Arguments: {JSON}
`.trim();
  }

  _llmType() {
    return 'agent_graph_model';
  }
}
