import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

import { generateToolMarkdown } from '../utils/generateToolMarkdown';
import { getArray } from '../utils/kit';
import { getIncrementalRepoMapPrompt } from '../utils/getRepoMapPrompt';
import { getSystemPromptTemplate } from '../utils/getSystemPromptTemplate';

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
  protected chatId = '';
  protected targetDir?: string;

  resetChat() {
    this.chatId = '';
  }

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

  constructor(fields?: BaseChatModelParams & { targetDir?: string }) {
    super(fields || {});

    this.chatId = '';
    this.mcpTools = [];
    this.mcpEnabled = true;
    this.targetDir = fields?.targetDir;
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
    if (!actionMatch) return [];

    let args: any = {};
    const argsIdx = text.search(/Arguments:\s*\{/);
    if (argsIdx !== -1) {
      const jsonStart = text.indexOf('{', argsIdx);
      const jsonStr = this.extractBalancedJson(text, jsonStart);
      if (jsonStr) {
        try {
          let raw: any = jsonStr;
          let safetyDepth = 0;
          while (typeof raw === 'string' && safetyDepth < 5) {
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed === 'object' && parsed !== null) {
                raw = parsed;
                break;
              }
              raw = parsed;
            } catch {
              break;
            }
            safetyDepth++;
          }
          args = raw;
        } catch {
          args = {};
        }
      }
    }

    return [
      {
        name: actionMatch[1],
        args: typeof args === 'object' ? args : {},
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'tool_call' as const,
      },
    ];
  }

  /** 从 text[start] 开始，按括号配对提取完整的 JSON 对象字符串 */
  private extractBalancedJson(text: string, start: number): string | null {
    if (start < 0 || start >= text.length || text[start] !== '{') return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.substring(start, i + 1);
      }
    }

    return null;
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
    const isFirstMessage = this.chatId === '';

    const format = (m: BaseMessage) => {
      const content =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
      return `${m._getType().toUpperCase()}: ${content}`;
    };

    const tools = this.getMcpEnabled() ? getArray(this.boundTools) : getArray(this.boundTools).filter(tool => !this.isMcpTool(tool))
    const toolsContext = tools.length
      ? `${generateToolMarkdown(tools)}`
      : '';

    const systemContext = isFirstMessage ? `
${isFirstMessage ? format(systemMsg as any) : ''}
${toolsContext}
${getIncrementalRepoMapPrompt(this.targetDir, isFirstMessage)}
`.trim() : `
${getSystemPromptTemplate(this.targetDir)}

## Active Tools (Summary)
Available: ${getArray(tools).map(t => t.function.name).join(', ')}

**Self-Correction**: If you encounter "tool not found" or need parameter details, you MUST call:
- \`get_all_tools_schema\`: Retrieve full tool definitions and schemas.

${getIncrementalRepoMapPrompt(this.targetDir, isFirstMessage)}
`.trim();

    return `
${systemContext}
# Current Progress
${format(lastMsg)}
# Output Requirement
1. Reasoning in <think> tags.
2. Action: ToolName
3. Arguments: {"key": "value"} (MUST be a single-line compact JSON, no newlines inside)
`.trim();
  }

  _llmType() {
    return 'agent_graph_model';
  }
}
