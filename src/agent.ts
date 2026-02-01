import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import os from "os";
import * as readline from "readline";
import { PromptEngine } from "@saber2pr/ts-context-mcp"; // 引入我们的核心引擎
import { getEncoding } from "js-tiktoken";

// --- 配置定义 ---
interface McpConfig {
  mcpServers: {
    [key: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

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
  _handler?: (args: any) => Promise<any>; // 内置工具处理器
  _client?: Client; // 外部 MCP 客户端
  _originalName?: string;
}

// 定义工具扩展接口
export interface CustomTool {
  name: string;
  description: string;
  parameters: any;
  handler: (args: any) => Promise<any>;
}

export interface AgentOptions {
  targetDir?: string;
  /** 自定义工具扩展 */
  tools?: any[];
  /** 注入到 System Prompt 中的额外指令/规则/上下文 */
  extraSystemPrompt?: any;
  maxTokens?: number
  apiConfig?: ApiConfig
}

const CONFIG_FILE = path.join(os.homedir(), ".saber2pr-agent.json");

export default class McpAgent {
  private openai!: OpenAI;
  private modelName: string = "";
  private clients: Client[] = [];
  private allTools: ToolInfo[] = [];
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private engine: PromptEngine;
  private encoder = getEncoding("cl100k_base");
  private extraTools: CustomTool[] = [];
  private maxTokens: number;
  private apiConfig: ApiConfig

  constructor(options?: AgentOptions) {
    this.engine = new PromptEngine(options?.targetDir || process.cwd());
    this.extraTools = options?.tools || []; // 接收外部传入的工具
    this.maxTokens = options?.maxTokens || 100000; // 默认 100k
    this.apiConfig = options?.apiConfig

    let baseSystemPrompt = `你是一个专业的 AI 代码架构师，具备深度的源码分析与工程化处理能力。

    ### 核心操作规范：
    1. **全局扫描（强制首选）**：在开始任何分析任务前，你【必须】首先调用 'get_repo_map'。这是你理解项目目录结构、技术栈及模块关系的唯一权威来源。
    2. **循序渐进的分析路径**：
       - 优先使用 'read_skeleton' 提取接口、类和函数签名，以最低的 Token 成本建立代码逻辑视图。
       - 仅在需要深入分析具体业务逻辑、提取精准代码块或进行代码修改建议时，才使用 'read_full_code' 或 'get_method_body'。
    3. **真实性原则**：
       - 所有的代码分析、行号定位和逻辑推断必须基于工具返回的真实内容，严禁基于文件名进行虚假猜测。
       - 如果工具返回结果为空或报错，应尝试调整路径或更换工具。
    
    ### 技术能力：
    - 精通 TypeScript/JavaScript 及其 AST 结构，能准确识别各种复杂的声明与调用关系。
    - 能够理解代码间的依赖链路，并结合项目上下文给出合理的架构建议。
    
    ### 执行准则：
    - **任务导向**：直接通过工具链解决问题，减少不必要的中间对话。
    - **自主决策**：根据任务需求自主选择最合适的工具组合，无需每一步都向用户请示。`;

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

    // 初始化内置工具
    this.registerBuiltinTools();
    this.injectCustomTools(); // 注入外部工具
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

  private injectCustomTools() {
    for (const tool of this.extraTools) {
      this.allTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        _handler: tool.handler,
      });
    }
  }

  /**
   * 核心功能：内置代码分析工具
   * 这里的逻辑直接调用 PromptEngine，不走网络请求，效率极高
   */
  private registerBuiltinTools() {
    const builtinTools: ToolInfo[] = [
      {
        type: "function",
        function: {
          name: "get_repo_map",
          description: "获取项目全局文件结构及导出清单，用于快速定位代码",
          parameters: { type: "object", properties: {} },
        },
        _handler: async () => {
          this.engine.refresh();
          return this.engine.getRepoMap();
        },
      },
      {
        type: "function",
        function: {
          name: "analyze_deps",
          description: "分析指定文件的依赖关系，支持 tsconfig 路径别名解析",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "文件相对路径" },
            },
            required: ["filePath"],
          },
        },
        _handler: async ({ filePath }) => this.engine.getDeps(filePath),
      },
      {
        type: "function",
        function: {
          name: "read_skeleton",
          description:
            "提取文件的结构定义（接口、类、方法签名），忽略具体实现以节省 Token",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "文件相对路径" },
            },
            required: ["filePath"],
          },
        },
        _handler: async (args: any) => {
          // 1. 严格路径守卫：防止 undefined 或空字符串进入 path 模块
          const pathArg = args?.filePath;
          if (typeof pathArg !== 'string' || pathArg.trim() === '') {
            return `Error: 参数 'filePath' 无效。收到的是: ${JSON.stringify(pathArg)}`;
          }

          try {
            // 2. 刷新引擎状态，确保分析的是最新的文件内容
            this.engine.refresh();

            // 3. 执行获取
            const result = this.engine.getSkeleton(pathArg);

            // 4. 空值回退：防止 getSkeleton 返回 null 导致后续统计 Token 时崩溃
            return result || `// Warning: 文件 ${pathArg} 存在但未找到任何可提取的结构。`;
          } catch (error: any) {
            // 5. 捕获 AST 级别的 match 错误
            return `Error: 解析文件 ${pathArg} 时发生内部错误: ${error.message}`;
          }
        },
      },
      {
        type: "function",
        function: {
          name: "get_method_body",
          description: "获取指定文件内某个方法或函数的完整实现代码",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "文件路径" },
              methodName: { type: "string", description: "方法名或函数名" },
            },
            required: ["filePath", "methodName"],
          },
        },
        _handler: async ({ filePath, methodName }) => {
          // --- 新增：同样的 Token 守卫 ---
          if (this.calculateTokens() > this.maxTokens) {
            return `[SYSTEM WARNING]: Token 消耗已达上限，禁止获取详细方法体。请利用已获取的 Skeleton 信息进行分析。`;
          }
          return this.engine.getMethodImplementation(filePath, methodName)
        },
      },
      {
        type: "function",
        function: {
          name: "read_full_code",
          description: "读取指定文件的完整源代码内容。当需要分析具体实现逻辑或查找硬编码字符串时使用。",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "文件相对路径" },
            },
            required: ["filePath"],
          },
        },
        // 核心实现：直接利用 fs 读取
        _handler: async ({ filePath }) => {
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
        },
      },
    ];

    this.allTools.push(...builtinTools);
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
          ...tools.map((t) => ({
            type: "function" as const,
            function: {
              name: `${name}__${t.name}`,
              description: t.description,
              parameters: t.inputSchema,
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
          tools: this.allTools.map(({ _handler, _client, _originalName, ...rest }) => rest) as any,
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

        console.log(`   🛠️  执行: ${call.function.name}`);
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
    console.log(`\n🚀 代码助手已启动 (目标目录: ${this.engine.getRootDir()})`);

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
