import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

export interface AgentGraphLLMResponse {
  text: string;
  reasoning?: string;
  chatId?: string;
  // ✅ 新增：支持透传这些元数据
  token?: number;
  duration?: number;
}

export abstract class AgentGraphModel extends BaseChatModel {
  protected boundTools?: any[];
  protected chatId?: string;

  constructor(fields?: BaseChatModelParams & { chatId?: string }) {
    super(fields || {});
    this.chatId = fields?.chatId;
  }

  bindTools(tools: any[]): any {
    this.boundTools = tools.map(t => convertToOpenAITool(t));
    return this;
  }

  // 子类只需实现这个方法，返回 fetch 的配置或直接返回响应
  abstract callApi(prompt: string, chatId?: string): Promise<AgentGraphLLMResponse>;

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const fullPrompt = this.serializeMessages(messages);
    const response = await this.callApi(fullPrompt, this.chatId);

    let { text, reasoning, token, duration } = response;

    // 1. 处理思考内容
    if (!reasoning && text.includes("<think>")) {
      const match = text.match(/<think>([\s\S]*?)<\/think>/);
      if (match) {
        reasoning = match[1].trim();
        text = text.replace(/<think>[\s\S]*?<\/think>/, "").trim();
      }
    }

    // 2. 解析工具调用
    const toolCalls = this.parseToolCalls(text);

    // AgentGraphModel.ts 的 _generate 方法内
    return {
      generations: [{
        text,
        message: new AIMessage({
          content: text,
          tool_calls: toolCalls,
          additional_kwargs: {
            reasoning: reasoning || "",
            token: response.token,      // 👈 必须
            duration: response.duration, // 👈 必须
            chatId: response.chatId
          },
          response_metadata: {
            reasoning: reasoning || "",
            token: response.token,      // 👈 McpGraphAgent 读取路径
            duration: response.duration,
            chatId: response.chatId
          }
        })
      }]
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
    return [{
      name: actionMatch[1],
      args: typeof args === 'object' ? args : {},
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "tool_call" as const,
    }];
  }

  private serializeMessages(messages: BaseMessage[]): string {
    const systemMsg = messages.find(m => m._getType() === 'system');
    const lastMsg = messages[messages.length - 1];

    const format = (m: BaseMessage) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
      return `${m._getType().toUpperCase()}: ${content}`;
    };

    const toolsContext = this.boundTools ? `\n[Tools]\n${JSON.stringify(this.boundTools, null, 2)}` : "";

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

  _llmType() { return "agent_graph_model"; }
}