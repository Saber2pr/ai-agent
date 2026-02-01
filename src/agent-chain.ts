import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import * as readline from "readline";
import { PromptEngine } from "@saber2pr/ts-context-mcp";
import { getEncoding } from "js-tiktoken";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { PromptTemplate } from "@langchain/core/prompts";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

// --- 类型定义 ---
interface ApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

interface ToolInfo {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any;
  };
  _handler?: (args: any) => Promise<any>;
}

export interface CustomTool {
  name: string;
  description: string;
  parameters: any;
  handler: (args: any) => Promise<any>;
}

export interface AgentOptions {
  targetDir?: string;
  tools?: CustomTool[];
  extraSystemPrompt?: any;
  maxTokens?: number;
  apiConfig?: ApiConfig
  apiModel?: BaseChatModel
  maxIterations?: number
}

const CONFIG_FILE = path.join(os.homedir(), ".saber2pr-agent.json");

export default class McpChainAgent {
  private allTools: ToolInfo[] = [];
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private engine: PromptEngine;
  private encoder = getEncoding("cl100k_base");
  private extraTools: CustomTool[] = [];
  private maxTokens: number;
  private executor?: AgentExecutor;
  private apiConfig: ApiConfig
  private maxIterations: number
  private apiModel?: BaseChatModel

  constructor(options?: AgentOptions) {
    this.engine = new PromptEngine(options?.targetDir || process.cwd());
    this.extraTools = options?.tools || [];
    this.maxTokens = options?.maxTokens || 100000;
    this.apiConfig = options?.apiConfig
    this.maxIterations = options?.maxIterations || 20
    this.apiModel = options?.apiModel

    const baseSystemPrompt = `你是一个专业的 AI 代码架构师，具备深度的源码分析与工程化处理能力。
    
### 核心操作规范：
1. **全局扫描（强制首选）**：在开始任何分析任务前，你【必须】首先调用 'get_repo_map'。这是理解项目结构、技术栈及模块关系的唯一来源。
2. **循序渐进的分析路径**：
   - 优先使用 'read_skeleton' 提取接口和函数签名。
   - 仅在需要分析具体逻辑或准备修复代码时，才使用 'read_full_code'。
3. **真实性原则**：所有的代码分析必须基于工具返回的真实内容，严禁虚假猜测。`;

    this.messages.push({
      role: "system",
      content: options?.extraSystemPrompt
        ? `${baseSystemPrompt}\n\n[额外指令]:\n${JSON.stringify(options.extraSystemPrompt)}`
        : baseSystemPrompt,
    });

    this.registerBuiltinTools();
    this.injectCustomTools();
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

  private registerBuiltinTools() {
    const builtinTools: ToolInfo[] = [
      {
        type: "function",
        function: { name: "get_repo_map", description: "获取项目全局结构图和导出清单", parameters: { type: "object" } },
        _handler: this.wrapHandler("get_repo_map", async () => {
          this.engine.refresh();
          return this.engine.getRepoMap();
        }),
      },
      {
        type: "function",
        function: {
          name: "read_skeleton",
          description: "读取代码骨架（接口、类定义等），非常节省 Token",
          parameters: { type: "object", properties: { filePath: { type: "string" } } },
        },
        _handler: this.wrapHandler("read_skeleton", async ({ filePath }) => this.engine.getSkeleton(filePath)),
      },
      {
        type: "function",
        function: {
          name: "read_full_code",
          description: "读取完整源码。注意：仅在需要具体行号或精细逻辑时使用",
          parameters: { type: "object", properties: { filePath: { type: "string" } } },
        },
        _handler: this.wrapHandler("read_full_code", async ({ filePath }) => {
          // --- 新增：Token 守卫 ---
          const currentTokens = this.calculateTokens();
          if (currentTokens > this.maxTokens) {
            return `[SYSTEM WARNING]: 当前上下文已达到 ${currentTokens} tokens (上限 ${this.maxTokens})。为了保证系统稳定，已拦截 read_full_code。请立即根据已知信息进行总结或停止阅读更多代码。`;
          }

          try {
            if (typeof filePath !== 'string' || !filePath) {
              return "Error: filePath 不能为空";
            }
            // 拼合绝对路径
            const fullPath = path.resolve(this.engine.getRootDir(), filePath);

            // 安全检查：防止 AI 尝试读取项目外的敏感文件
            if (!fullPath.startsWith(this.engine.getRootDir())) {
              return "Error: 权限拒绝，禁止访问项目目录外的文件。";
            }

            if (!fs.existsSync(fullPath)) {
              return `Error: 文件不存在: ${filePath}`;
            }

            const content = fs.readFileSync(fullPath, "utf-8");
            // 加上行号，AI 就能在 generate_review 里给出准确的 line 参数
            return content.split('\n')
              .map((line, i) => `${i + 1} | ${line}`)
              .join('\n');
          } catch (err: any) {
            return `Error: 读取文件失败: ${err.message}`;
          }
        }),
      }
    ];
    this.allTools.push(...builtinTools);
  }

  private injectCustomTools() {
    for (const tool of this.extraTools) {
      this.allTools.push({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        _handler: this.wrapHandler(tool.name, tool.handler),
      });
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

    const langchainTools = this.allTools.map(t => new DynamicTool({
      name: t.function.name,
      description: t.function.description || "",
      func: t._handler
    }));

    const prompt = PromptTemplate.fromTemplate(`
{system_prompt}

TOOLS:
------
You can use the following tools:
{tools}

To use a tool, please use the following format:
Thought: Do I need to use a tool? Yes
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action (JSON format)
Observation: the result of the action
... (repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!
Question: {input}
Thought: {agent_scratchpad}`);

    const agent = await createReactAgent({ llm: model, tools: langchainTools, prompt });
    this.executor = new AgentExecutor({
      agent,
      tools: langchainTools,
      verbose: false, // 我们已经有了 wrapHandler 日志，关闭原生 verbose 以保持整洁
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
      });

      let output = response.output;
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
    console.log(`📂 目标目录: ${this.engine.getRootDir()}`);

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