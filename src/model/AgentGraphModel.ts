import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

export interface AgentGraphLLMResponse {
  text: string;
  reasoning?: string;
  chatId?: string;
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
    
    if (response.chatId) this.chatId = response.chatId;

    let { text, reasoning } = response;

    // ✅ 通用逻辑：解析 <think> 标签
    if (!reasoning && text.includes("<think>")) {
      const match = text.match(/<think>([\s\S]*?)<\/think>/);
      if (match) {
        reasoning = match[1].trim();
        text = text.replace(/<think>[\s\S]*?<\/think>/, "").trim();
      }
    }

    const toolCalls = this.parseToolCalls(text);

    return {
      generations: [{
        text,
        message: new AIMessage({ 
          content: text, 
          tool_calls: toolCalls,
          additional_kwargs: { reasoning: reasoning || "" } 
        })
      }]
    };
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

  private parseToolCalls(text: string) {
    const actionMatch = text.match(/Action:\s*(\w+)/);
    const argsMatch = text.match(/Arguments:\s*({[\s\S]*})/);
    if (!actionMatch) return [];

    let args = {};
    if (argsMatch) {
      try {
        // 强力解析逻辑，处理物理换行
        const rawArgs = argsMatch[1].trim().replace(/\n/g, "\\n");
        args = JSON.parse(rawArgs);
        // 参数映射
        const anyArgs = args as any;
        if (anyArgs.file_path && !anyArgs.path) anyArgs.path = anyArgs.file_path;
        if (anyArgs.filePath && !anyArgs.path) anyArgs.path = anyArgs.filePath;
        if (anyArgs.path && !anyArgs.filePath) anyArgs.filePath = anyArgs.path;
        if (anyArgs.file && !anyArgs.filePath) anyArgs.filePath = anyArgs.file;
      } catch (e) { console.warn("JSON Parse Error", e); }
    }

    return [{
      name: actionMatch[1],
      args,
      id: `call_${Date.now()}`,
      type: "tool_call" as const,
    }];
  }

  _llmType() { return "agent_graph_model"; }
}