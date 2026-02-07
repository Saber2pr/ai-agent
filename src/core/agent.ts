import fs from 'fs';
import { getEncoding } from 'js-tiktoken';
import OpenAI from 'openai';
import os from 'os';
import path from 'path';
import * as readline from 'readline';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CONFIG_FILE } from '../config/config';
import { createDefaultBuiltinTools } from '../tools/builtin';
import { AgentOptions, ApiConfig, McpConfig, ToolInfo } from '../types/type';
import { jsonSchemaToZod } from '../utils/jsonSchemaToZod';

export default class McpAgent {
  private openai!: OpenAI;
  private modelName: string = "";
  private allTools: ToolInfo[] = [];
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private encoder = getEncoding("cl100k_base");
  private extraTools: ToolInfo[] = [];
  private maxTokens: number;
  private apiConfig: ApiConfig
  private targetDir: string;
  constructor(options?: AgentOptions) {
    this.targetDir = options?.targetDir || process.cwd();
    this.extraTools = options?.tools || []; // 接收外部传入的工具
    this.maxTokens = options?.maxTokens || 100000; // 默认 100k
    this.apiConfig = options?.apiConfig

    let baseSystemPrompt = `你是一个专业的代码架构师。
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

    // 2. 拼接额外指令
    if (options?.extraSystemPrompt) {
      const extra = typeof options.extraSystemPrompt === 'string'
        ? options.extraSystemPrompt
        : JSON.stringify(options.extraSystemPrompt, null, 2);

      baseSystemPrompt += `\n\n[额外执行指令]:\n${extra}`;
    }

    this.messages.push({
      role: "system",
      content: baseSystemPrompt,
    });

    this.initTools(options); // 注入外部工具
  }

  /**
   * 计算当前消息列表的总 Token 消耗
   * 兼容多模态内容 (Content Parts) 和 工具调用 (Tool Calls)
   */
  private calculateTokens(): number {
    let total = 0;

    for (const msg of this.messages) {
      // 1. 处理消息内容 (Content)
      if (msg.content) {
        if (typeof msg.content === "string") {
          // 普通文本消息
          total += this.encoder.encode(msg.content).length;
        } else if (Array.isArray(msg.content)) {
          // 多模态/复合内容消息 (ChatCompletionContentPart[])
          for (const part of msg.content) {
            if (part.type === "text" && "text" in part) {
              total += this.encoder.encode(part.text || "").length;
            }
            // 注意：图片 (image_url) 的 Token 计算通常基于分辨率，tiktoken 无法计算
          }
        }
      }

      // 2. 处理助手角色发出的工具调用请求 (Assistant Tool Calls)
      // 这是为了统计 AI 发出的指令所占用的 Token
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const call of msg.tool_calls) {
          if (call.type === "function") {
            // 统计函数名和参数字符串
            total += this.encoder.encode(call.function.name).length;
            total += this.encoder.encode(call.function.arguments).length;
          }
        }
      }

      // 3. 处理工具返回的结果 (Tool Role)
      // 在 processChat 中，我们确保了工具返回的 result 最终被转为了 string
      if (msg.role === "tool" && typeof msg.content === "string") {
        total += this.encoder.encode(msg.content).length;
      }
    }

    return total;
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
      this.allTools.push(...allTools);
    }
  }

  // --- 初始化与环境准备 (API Config & MCP Servers) ---

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

  private loadMcpConfigs(): McpConfig {
    const combined: McpConfig = { mcpServers: {} };
    const paths = [
      path.join(os.homedir(), ".cursor", "mcp.json"),
      path.join(os.homedir(), ".vscode", "mcp.json"),
    ];
    paths.forEach((p) => {
      if (fs.existsSync(p)) {
        const content = JSON.parse(fs.readFileSync(p, "utf-8"));
        Object.assign(combined.mcpServers, content.mcpServers);
      }
    });
    return combined;
  }

  async init() {
    const apiConfig = await this.ensureApiConfig();
    this.openai = new OpenAI({
      baseURL: apiConfig.baseURL,
      apiKey: apiConfig.apiKey,
    });
    this.modelName = apiConfig.model;

    // 链接外部 MCP Server (如 Google Search, Filesystem 等)
    const mcpConfig = this.loadMcpConfigs();
    for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args || [],
          env: { ...process.env, ...server.env } as any,
        });
        const client = new Client(
          { name, version: "1.0.0" },
          { capabilities: {} },
        );
        await client.connect(transport);
        const { tools } = await client.listTools();

        this.allTools.push(
          ...tools.map((t): ToolInfo => ({
            type: "function" as const,
            function: {
              name: `${name}__${t.name}`,
              description: t.description,
              parameters: jsonSchemaToZod(t.inputSchema),
            },
            _originalName: t.name,
            _client: client,
          })),
        );
        console.log(`✅ [${name}] 加载成功`);
      } catch (e) {
        console.error(`❌ [${name}] 启动失败`);
      }
    }
  }

  private getToolsForOpenAIAPI() {
    return this.allTools.map((tool) => {
      const { _handler, _client, _originalName, ...rest } = tool;

      let parameters = rest.function.parameters as any;

      // 💡 核心逻辑：判断是否为 Zod 实例并转换
      // Zod 对象通常包含 _def 属性，或者你可以用 instanceof z.ZodType
      if (parameters && typeof parameters === 'object' && ('_def' in parameters || parameters.safeParse)) {
        // 使用 zod-to-json-schema 转换为标准 JSON Schema
        parameters = zodToJsonSchema(parameters);
      }

      return {
        ...rest,
        function: {
          ...rest.function,
          parameters: parameters, // 确保这里是 Plain Object
        },
      };
    });
  }

  private async processChat(userInput: string) {
    this.messages.push({ role: 'user', content: userInput });

    while (true) {
      // --- 新增：发送请求前先检查并裁剪 ---
      this.pruneMessages();

      // 打印当前上下文的累计 Token
      const currentInputTokens = this.calculateTokens();
      console.log(`\n📊 当前上下文累计: ${currentInputTokens} tokens`);

      // 如果接近上限（如 80%），在消息队列中插入一条隐含的系统指令
      if (currentInputTokens > this.maxTokens * 0.8 && currentInputTokens <= this.maxTokens) {
        this.messages.push({
          role: "system",
          content: "注意：上下文即将耗尽。请停止读取新文件，优先处理现有信息并尽快输出结果。"
        });
      }

      const stopLoading = this.showLoading("🤖 Agent 正在思考...");

      let response;
      try {
        response = await this.openai.chat.completions.create({
          model: this.modelName,
          messages: this.messages,
          tools: this.getToolsForOpenAIAPI(),
          tool_choice: 'auto'
        });
      } finally {
        stopLoading();
      }

      const message = response.choices[0].message;
      this.messages.push(message);

      // 计算本次 AI 回复生成的 Token
      const completionTokens = response.usage?.completion_tokens ||
        (message.content ? this.encoder.encode(message.content).length : 0);
      console.log(`✨ AI 回复消耗: ${completionTokens} tokens`);

      if (!message.tool_calls) {
        console.log(`\n🤖 Agent: ${message.content}`);
        break;
      }

      console.log(`\n⚙️ 正在执行 ${message.tool_calls.length} 个操作...`);

      for (const call of message.tool_calls) {
        const tool = this.allTools.find(t => t.function.name === call.function.name);
        const args = JSON.parse(call.function.arguments);

        // 打印文件路径提示
        if (args.filePath) {
          console.log(`   📂 正在查看文件: ${args.filePath}`);
        }

        // 2. 打印操作信息和参数
        console.log(`\n   🛠️  执行工具: \x1b[36m${call.function.name}\x1b[0m`);
        console.log(`   📦 传入参数: \x1b[2m${JSON.stringify(args)}\x1b[0m`);

        let result: any;

        if (tool?._handler) {
          result = await tool._handler(args);
        } else if (tool?._client && tool._originalName) {
          const mcpRes = await tool._client.callTool({
            name: tool._originalName,
            arguments: args
          });
          result = mcpRes.content;
        }

        const resultContent = typeof result === "string" ? result : JSON.stringify(result);

        // 打印工具返回结果的 Token 消耗
        const toolResultTokens = this.encoder.encode(resultContent).length;
        console.log(`   📝 工具输出: ${toolResultTokens} tokens`);

        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultContent
        });
        console.log(`   ✅ 完成: ${call.function.name}`);
      }
    }
  }

  /**
 * 裁剪上下文消息列表
 * 保留第一条 System 消息，并移除中间的旧消息直到低于阈值
 */
  private pruneMessages() {
    const currentTokens = this.calculateTokens();
    if (currentTokens <= this.maxTokens) return;

    console.log(`\n⚠️ 上下文达到限制 (${currentTokens} tokens)，正在自动裁剪...`);

    // 策略：保留索引 0 (System)，从索引 1 开始删除
    // 每次删除一对 (通常是助理请求 + 工具回复，或者用户提问 + 助理回答)
    while (this.calculateTokens() > this.maxTokens && this.messages.length > 2) {
      // 始终保留系统提示词 (index 0) 和最后一条消息 (保持对话连贯)
      // 删除索引为 1 的消息
      this.messages.splice(1, 1);
    }

    console.log(`✅ 裁剪完成，当前上下文: ${this.calculateTokens()} tokens`);
  }

  /**
   * 简易 Loading 动画辅助函数
   */
  private showLoading(text: string) {
    const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const timer = setInterval(() => {
      process.stdout.write(`\r${chars[i]} ${text}`);
      i = (i + 1) % chars.length;
    }, 80);

    return () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K'); // 清除当前行
    };
  }

  /**
   * 编程式对话入口
   * @param input 用户指令
   * @returns AI 的最终答复内容
   */
  async chat(input: string): Promise<string> {
    if (!this.openai) {
      await this.init();
    }

    // 调用现有的处理逻辑
    // 假设你的 processChat 已经处理了所有的 tool_calls 循环
    await this.processChat(input);

    // 返回消息列表中的最后一条 AI 回复
    const lastMsg = this.messages[this.messages.length - 1];
    return lastMsg.role === 'assistant' ? (lastMsg.content as string) : '';
  }

  // 修改原来的 start 方法，使其内部也调用 chat
  async start() {
    if (!this.openai) {
      await this.init();
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    console.log(`\n🚀 代码助手已启动 (目标目录: ${this.targetDir})`);

    const chatLoop = () => {
      rl.question("\n👤 你: ", async (input) => {
        if (input.toLowerCase() === "exit") process.exit(0);
        try {
          // 这里统一调用 chat 或核心逻辑
          await this.chat(input);
        } catch (err: any) {
          console.error("\n❌ 系统错误:", err.message);
        }
        chatLoop();
      });
    };
    chatLoop();
  }
}
