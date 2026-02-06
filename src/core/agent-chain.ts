import fs from 'fs';
import { getEncoding } from 'js-tiktoken';
import { AgentExecutor, createStructuredChatAgent } from 'langchain/agents';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PromptTemplate } from '@langchain/core/prompts';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { ConversationSummaryBufferMemory } from "langchain/memory";
import * as readline from 'readline';

import { CONFIG_FILE } from '../config/config';
import { AgentOptions, ApiConfig, ToolInfo } from '../types/type';
import { jsonSchemaToZod } from '../utils/jsonSchemaToZod';
import { createDefaultBuiltinTools } from '../tools/builtin';

export default class McpChainAgent {
  private allTools: ToolInfo[] = [];
  private encoder = getEncoding("cl100k_base");
  private extraTools: ToolInfo[] = [];
  private maxTokens: number;
  private executor?: AgentExecutor;
  private apiConfig: ApiConfig;
  private maxIterations: number;
  private apiModel?: BaseChatModel;
  private memory?: ConversationSummaryBufferMemory;
  private systemPrompt: string;
  private runningTokenCounter: number = 0;

  constructor(options?: AgentOptions) {
    this.extraTools = options?.tools || [];
    this.maxTokens = options?.maxTokens || 100000;
    this.apiConfig = options?.apiConfig;
    this.maxIterations = options?.maxIterations || 20;
    this.apiModel = options?.apiModel;

    const baseSystemPrompt = `你是一个专业的 AI 代码架构师。
    
### 核心规范：
1. **全局扫描**：首选调用 'get_repo_map'。
2. **循序渐进**：优先使用 'read_skeleton'，仅在必要时使用 'read_text_file'。
3. **真实性**：严禁虚假猜测。`;

    this.systemPrompt = options?.extraSystemPrompt
      ? `${baseSystemPrompt}\n\n[额外指令]:\n${JSON.stringify(options.extraSystemPrompt)}`
      : baseSystemPrompt;

    this.initTools(options);
  }

  private initTools(options: AgentOptions) {
    const allTools = [...createDefaultBuiltinTools({ options: { ...options, ...this } }), ...this.extraTools];
    this.allTools = allTools.map((t) => ({
      ...t,
      _handler: this.wrapHandler(t.function.name, t._handler),
    }));
  }

  private wrapHandler(name: string, handler: (args: any) => Promise<any>) {
    return async (args: any) => {
      console.log(`\n   [工具调用]: ${name}`);
      const result = await handler(args);
      const content = typeof result === "string" ? result : JSON.stringify(result);
      this.runningTokenCounter += this.encoder.encode(content).length;
      return content;
    };
  }

  async init() {
    if (this.executor) return;

    let model: BaseChatModel;
    if (this.apiModel) {
      model = this.apiModel;
    } else {
      const apiConfig = await this.ensureApiConfig();
      model = new ChatOpenAI({
        configuration: { baseURL: apiConfig.baseURL, apiKey: apiConfig.apiKey },
        modelName: apiConfig.model,
        temperature: 0,
      });
    }

    // 1. 初始化 SummaryBufferMemory
    // maxTokenLimit 决定了当对话历史超过多少 Token 时触发“自动总结”
    this.memory = new ConversationSummaryBufferMemory({
      llm: model,
      maxTokenLimit: 2000,
      memoryKey: "chat_history",
      returnMessages: true,
      // 必须添加下面这两行显式声明：
      inputKey: "input",    // 对应 invoke 里的 input 字段
      outputKey: "output",  // 对应 Agent 输出的字段
    });

    const langchainTools = this.allTools.map(t => new DynamicStructuredTool({
      name: t.function.name,
      description: t.function.description || "",
      schema: jsonSchemaToZod(t.function.parameters),
      func: async (args) => await t._handler(args),
    }));

    // 2. 构造支持 Memory 的 Prompt
    const prompt = PromptTemplate.fromTemplate(`{system_prompt}

### 历史记录摘要及近期对话：
{chat_history}

### 可用工具：
{tools}

工具名称列表: [{tool_names}]

### 交互协议：
Thought: [你的中文分析思路]
\`\`\`json
{{
  "action": "工具名称",
  "action_input": {{ "参数名": "参数值" }}
}}
\`\`\`

Begin!
Question: {input}
Thought: {agent_scratchpad}`);

    const agent = await createStructuredChatAgent({ llm: model, tools: langchainTools, prompt });

    this.executor = new AgentExecutor({
      agent,
      tools: langchainTools,
      memory: this.memory, // 挂载内存模块
      verbose: false,
      handleParsingErrors: true,
      maxIterations: this.maxIterations
    });
  }

  async chat(input: string): Promise<string> {
    if (!this.executor) await this.init();

    this.runningTokenCounter = this.encoder.encode(input).length;

    const stopLoading = this.showLoading("🤖 Agent 正在思考并管理上下文...");
    try {
      // 执行请求，AgentExecutor 会自动：
      // 1. 从 memory 加载历史 (chat_history)
      // 2. 将这次对话的结果 saveContext 到 memory
      const response = await this.executor!.invoke({
        input: input,
        system_prompt: this.systemPrompt,
      }, {
        callbacks: [{
          handleAgentAction: (action) => {
            const thought = action.log.split(/```json|\{/)[0].replace(/Thought:/i, "").trim();
            if (thought && !thought.startsWith('{')) {
              console.log(`\n💭 [思考]: ${thought.split('\n')[0]}`);
            }
          }
        }]
      });

      return typeof response.output === 'string' ? response.output : JSON.stringify(response.output);
    } finally {
      stopLoading();
    }
  }

  private showLoading(text: string) {
    const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const timer = setInterval(() => {
      process.stdout.write(`\r${chars[i]} ${text}`);
      i = (i + 1) % chars.length;
    }, 80);
    return () => { clearInterval(timer); process.stdout.write('\r\x1b[K'); };
  }

  async start() {
    await this.init();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n🚀 AI 助手 (Summary+Window 模式) 已启动`);
    const chatLoop = () => {
      rl.question("\n👤 你: ", async (input) => {
        if (!input.trim()) return chatLoop();
        if (input.toLowerCase() === "exit") process.exit(0);
        try {
          const res = await this.chat(input);
          console.log(`\n🤖 Agent: ${res}`);
        } catch (err: any) {
          console.error("\n❌ 系统错误:", err.message);
        }
        chatLoop();
      });
    };
    chatLoop();
  }

  private async ensureApiConfig(): Promise<ApiConfig> {
    if (this.apiConfig) return this.apiConfig;
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q: string) => new Promise<string>((res) => rl.question(q, res));
    const config = { baseURL: await question("? API Base URL: "), apiKey: await question("? API Key: "), model: await question("? Model Name: ") };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    rl.close();
    return config;
  }
}