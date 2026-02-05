import fs from 'fs';
import { getEncoding } from 'js-tiktoken';
import { AgentExecutor, createStructuredChatAgent } from 'langchain/agents';
import OpenAI from 'openai';
import * as readline from 'readline';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PromptTemplate } from '@langchain/core/prompts';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';

import { CONFIG_FILE } from '../config/config';
import { AgentOptions, ApiConfig, ToolInfo } from '../types/type';
import { jsonSchemaToZod } from '../utils/jsonSchemaToZod';
import { createDefaultBuiltinTools } from '../tools/builtin';

export default class McpChainAgent {
  private allTools: ToolInfo[] = [];
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private encoder = getEncoding("cl100k_base");
  private extraTools: ToolInfo[] = [];
  private maxTokens: number;
  private executor?: AgentExecutor;
  private apiConfig: ApiConfig
  private maxIterations: number
  private apiModel?: BaseChatModel
  private targetDir: string;
  private verbose: boolean;
  constructor(options?: AgentOptions) {
    this.extraTools = options?.tools || [];
    this.maxTokens = options?.maxTokens || 100000;
    this.apiConfig = options?.apiConfig
    this.maxIterations = options?.maxIterations || 20
    this.apiModel = options?.apiModel
    this.targetDir = options?.targetDir || process.cwd();
    this.verbose = options?.verbose || false;
    const baseSystemPrompt = `你是一个专业的 AI 代码架构师，具备深度的源码分析与工程化处理能力。
    
### 核心操作规范：
1. **全局扫描（强制首选）**：在开始任何分析任务前，你【必须】首先调用 'get_repo_map'。这是理解项目结构、技术栈及模块关系的唯一来源。
2. **循序渐进的分析路径**：
   - 优先使用 'read_skeleton' 提取接口和函数签名。
   - 仅在需要分析具体逻辑或准备修复代码时，才使用 'read_text_file'。
3. **真实性原则**：所有的代码分析必须基于工具返回的真实内容，严禁虚假猜测。`;

    this.messages.push({
      role: "system",
      content: options?.extraSystemPrompt
        ? `${baseSystemPrompt}\n\n[额外指令]:\n${JSON.stringify(options.extraSystemPrompt)}`
        : baseSystemPrompt,
    });


    this.initTools(options);
  }

  /**
   * 工具处理器包装逻辑：增加日志打印和 Token 监控
   */
  private wrapHandler(name: string, handler: (args: any) => Promise<any>) {
    return async (args: any) => {
      // 1. 打印工具执行日志
      console.log(`\n   [工具调用]: ${name}`);
      if (args?.filePath) {
        console.log(`   [目标文件]: ${args.filePath}`);
      }

      // 2. 执行逻辑
      const result = await handler(args);
      const content = typeof result === "string" ? result : JSON.stringify(result);

      // 3. 统计 Token 消耗
      const tokens = this.encoder.encode(content).length;
      console.log(`   [输出长度]: ${tokens} tokens`);

      return content;
    };
  }

  private initTools(options: AgentOptions) {
    const allTools = [
      // 注册内置工具
      ...createDefaultBuiltinTools({
        options: {
          ...options,
          ...this
        }
      }),
      ...this.extraTools
    ]

    if (allTools?.length) {
      this.allTools.push(
        ...allTools.map((t) => ({
          type: t.type as "function",
          function: t.function,
          _handler: this.wrapHandler(t.function.name, t._handler),
        }))
      );
    }
  }

  private calculateTokens(): number {
    return this.messages.reduce((acc, msg) => acc + this.encoder.encode(String(msg.content || "")).length, 0);
  }

  private pruneMessages() {
    const current = this.calculateTokens();
    if (current > this.maxTokens) {
      console.log(`\n⚠️ 上下文达到限制 (${current} tokens)，正在裁剪旧消息...`);
      // 保留 system prompt (index 0)，移除后续消息
      while (this.calculateTokens() > this.maxTokens * 0.8 && this.messages.length > 2) {
        this.messages.splice(1, 1);
      }
      console.log(`✅ 裁剪完成，当前: ${this.calculateTokens()} tokens`);
    }
  }

  async init() {
    if (this.executor) return;

    let model: BaseChatModel;

    if (this.apiModel) {
      console.log("ℹ️ 使用自定义 API Model 实例");
      model = this.apiModel;
    } else {
      // 降级方案：使用配置创建默认的 ChatOpenAI
      const apiConfig = await this.ensureApiConfig();
      console.log(`ℹ️ 使用默认 ChatOpenAI (${apiConfig.model})`);
      model = new ChatOpenAI({
        configuration: { baseURL: apiConfig.baseURL, apiKey: apiConfig.apiKey },
        modelName: apiConfig.model,
        temperature: 0,
        streaming: false
      });
    }

    const langchainTools = this.allTools.map(t => {
      return new DynamicStructuredTool({
        name: t.function.name,
        description: t.function.description || "",
        // 定义 schema 告诉 LangChain 这是一个对象输入
        // passthrough() 允许接收未在 schema 中显式定义的其他字段
        schema: jsonSchemaToZod(t.function.parameters),
        func: async (args) => {
          // 这里的 args 已经被 LangChain 自动解析为对象
          return await t._handler(args);
        },
      });
    });
    // src/core/agent-chain.ts 中的 prompt 修改
    const prompt = PromptTemplate.fromTemplate(`
{system_prompt}

### 🛠 可用工具列表 (TOOLS)
--------------------
{tools}

工具名称列表: [{tool_names}]

### 📝 交互协议格式 (PROTOCOL)
--------------------
你必须严格遵守以下回复格式：

Thought: 首先，我会[此处用中文简述你的分析思路和下一步目标]。
\`\`\`json
{{
  "action": "工具名称",
  "action_input": {{ "参数名": "参数值" }}
}}
\`\`\`

注意：
- 严禁直接输出 JSON，必须先写 Thought。
- Thought 必须包含具体的分析意图，不少于 10 个字。

Begin!
Question: {input}
Thought: {agent_scratchpad}`);

    const agent = await createStructuredChatAgent({ llm: model, tools: langchainTools, prompt });
    this.executor = new AgentExecutor({
      agent,
      tools: langchainTools,
      verbose: this.verbose, // 我们已经有了 wrapHandler 日志，关闭原生 verbose 以保持整洁
      handleParsingErrors: true,
      maxIterations: this.maxIterations
    });
  }

  async chat(input: string): Promise<string> {
    if (!this.executor) await this.init();

    this.messages.push({ role: "user", content: input });
    this.pruneMessages();

    console.log(`\n📊 状态: Context ${this.calculateTokens()} / Limit ${this.maxTokens} tokens`);

    const stopLoading = this.showLoading("🤖 Agent 正在思考并执行工具...");
    try {
      const response = await this.executor.invoke({
        input: input,
        system_prompt: this.messages[0].content,
      }, {
        // --- 新增：使用回调函数捕获 Thought ---
        callbacks: [{
          handleAgentAction: (action, runId) => {
            if (action.log) {
              const log = action.log.trim();

              // 1. 提取 Thought 部分：取 Thought: 之后，直到遇到 ```json 或 { 之前的内容
              const thoughtMatch = log.match(/Thought:\s*([\s\S]*?)(?=(?:```json|\{|Action:|$))/i);

              let thought = "";
              if (thoughtMatch && thoughtMatch[1]) {
                thought = thoughtMatch[1].trim();
              } else {
                // 备选方案：如果没有 Thought 标签，直接截取 JSON 之前的文本
                thought = log.split(/```json|\{/)[0].replace(/Thought:/i, "").trim();
              }

              // 2. 只有当 thought 真的有文字内容（且不是 JSON）时才打印
              if (thought && thought.length > 0 && !thought.startsWith('{')) {
                // 进一步清洗：如果 thought 包含多行，只取非空的第一行，避免打印太长
                const displayThought = thought.split('\n').find(line => line.trim().length > 0);
                if (displayThought) {
                  console.log(`\n💭 [思考]: ${displayThought}`);
                }
              }
            }
          }
        }]
      });

      // 修复点：确保 output 是字符串
      let output = typeof response.output === 'string'
        ? response.output
        : JSON.stringify(response.output);

      // 清洗 ReAct 冗余标签
      if (output.includes("Final Answer:")) {
        output = output.split("Final Answer:").pop()?.trim() || output;
      }

      this.messages.push({ role: "assistant", content: output });
      return output;
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
    return () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
    };
  }

  async start() {
    await this.init();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n🚀 AI 助手启动 (LangChain 核心)`);
    console.log(`📂 目标目录: ${this.targetDir}`);

    const chatLoop = () => {
      rl.question("\n👤 你: ", async (input) => {
        if (!input.trim()) return chatLoop();
        if (input.toLowerCase() === "exit") process.exit(0);

        try {
          const result = await this.chat(input);
          console.log(`\n🤖 Agent: ${result}`);
        } catch (err: any) {
          console.error("\n❌ 系统错误:", err.message);
        }
        chatLoop();
      });
    };
    chatLoop();
  }

  private async ensureApiConfig(): Promise<ApiConfig> {
    if (this.apiConfig) return this.apiConfig

    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const question = (q: string) =>
      new Promise<string>((res) => rl.question(q, res));

    console.log("\n🔑 配置 API 凭据:");
    const config = {
      baseURL: await question(
        "? API Base URL (如 https://api.openai.com/v1): ",
      ),
      apiKey: await question("? API Key: "),
      model: await question("? Model Name (如 gpt-4o): "),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    rl.close();
    return config;
  }
}