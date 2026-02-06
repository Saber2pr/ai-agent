import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, MessageFieldWithRole } from "@langchain/core/messages";

interface AgentChainModelImpl {
  generateAgentChainResponse: (messages: MessageFieldWithRole[]) => Promise<string>;
}

export abstract class AgentChainModel extends BaseChatModel implements AgentChainModelImpl {
  bind(args: any): any {
    // 逻辑上调用基类（即使基类在类型上说没有，运行时通常是有的）
    // 如果运行时也没有，这里就返回 this 本身
    // @ts-ignore
    return (super.bind ? super.bind(args) : this) as any;
  }

  constructor(fields?) { super(fields || {}); }

  async generateAgentChainResponse(messages: MessageFieldWithRole[]) {
    return ''
  }

  async _generate(messages) {
    let text = await this.generateAgentChainResponse(messages);
    return { generations: [{ text, message: new AIMessage(text) }] };
  }
  _llmType() { return "my_private_llm"; }
}