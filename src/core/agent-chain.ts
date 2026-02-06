import fs from 'fs';
import { getEncoding } from 'js-tiktoken';
import { AgentExecutor, createStructuredChatAgent } from 'langchain/agents';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PromptTemplate } from '@langchain/core/prompts';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { ChatMessageHistory, ConversationSummaryBufferMemory } from "langchain/memory";
import * as readline from 'readline';

import { CONFIG_FILE } from '../config/config';
import { AgentOptions, ApiConfig, ToolInfo } from '../types/type';
import { jsonSchemaToZod } from '../utils/jsonSchemaToZod';
import { createDefaultBuiltinTools } from '../tools/builtin';
import { BaseLanguageModelInterface } from '@langchain/core/language_models/base';

export default class McpChainAgent {
  private allTools: ToolInfo[] = [];
  private encoder = getEncoding("cl100k_base");
  private extraTools: ToolInfo[] = [];
  private maxTokens: number;
  private executor?: AgentExecutor;
  private apiConfig: ApiConfig;
  private maxIterations: number;
  private apiModel?: BaseLanguageModelInterface;
  private memory?: ConversationSummaryBufferMemory;
  private systemPrompt: string;
  private runningTokenCounter: number = 0;
  private verbose: boolean;

  constructor(options?: AgentOptions) {
    this.extraTools = options?.tools || [];
    this.maxTokens = options?.maxTokens || 100000;
    this.apiConfig = options?.apiConfig;
    this.maxIterations = options?.maxIterations || 10;
    this.apiModel = options?.apiModel;
    this.verbose = options?.verbose || false;

    const baseSystemPrompt = `你是一个专业的代码架构师。
你的目标是理解并分析用户项目，请务必遵循以下工作流：

### 第一阶段：全景感知 (The "Where" Phase)
1. **必须首先调用 'get_directory_tree'**：获取项目完整文件列表，包括样式文件 (.less, .css) 和资源文件。
2. 结合目录结构，观察项目架构（如 Monorepo 结构或 src 布局）。

### 第二阶段：逻辑映射 (The "What" Phase)
1. **调用 'get_repo_map'**：针对代码文件提取导出定义，理解模块间的调用关系。
2. 如果需要查看具体的样式定义，直接使用 'read_text_file' 读取 .less 或 .css 文件。

### 核心原则：
- 不要猜测文件是否存在，先看目录树。
- 优先查看 Skeleton（骨架），只有需要修复逻辑时才读取完整 Text（全文）。
- 始终以中文回答思考过程。`;

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

    let model: BaseLanguageModelInterface;
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
      chatHistory: new ChatMessageHistory(), // 👈 显式指定 history 实例
    });

    const langchainTools = this.allTools.map(t => new DynamicStructuredTool({
      name: t.function.name,
      description: t.function.description || "",
      schema: jsonSchemaToZod(t.function.parameters),
      func: async (args) => await t._handler(args),
    }));

    const prompt = PromptTemplate.fromTemplate(`{system_prompt}

### 🛠 可用工具：
{tools}

### 🛠 工具名称：
[{tool_names}]

### 📝 历史记录：
{chat_history}

### ⚠️ 回复规范（严格遵守）：
1. 首先输出 **Thought:**，用中文详细说明你的分析思路。
2. 接着输出一个 **JSON Action 代码块**。

示例格式：
Thought: 正在查看目录。
\`\`\`json
{{
  "action": "directory_tree",
  "action_input": {{}}
}}
\`\`\`

Begin!
Question: {input}
{agent_scratchpad}`); // 👈 强制以 Thought: 开头，解决断更问题

    const agent = await createStructuredChatAgent({ llm: model, tools: langchainTools, prompt });

    this.executor = new AgentExecutor({
      agent,
      tools: langchainTools,
      memory: this.memory, // 挂载内存模块
      verbose: this.verbose,
      maxIterations: this.maxIterations,
      handleParsingErrors: (e) => {
        // 简化报错，不要再给 AI 错误的 JSON 示例
        return `格式不正确。请确保你输出了一个正确的 Markdown JSON 代码块，例如：\n\`\`\`json\n{ "action": "...", "action_input": { ... } }\n\`\`\``;
      },
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
            const rawLog = action.log || "";
            // 兼容 Thought: Thought: [内容]
            let thought = rawLog.split(/```json|\{/)[0]
              .replace(/Thought:/gi, "") // 全局替换掉所有 Thought: 标签
              .trim();

            if (thought) {
              console.log(`\n💭 [思考]: ${thought}`);
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