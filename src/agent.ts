import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import os from "os";
import * as readline from "readline";
import { PromptEngine } from "@saber2pr/ts-context-mcp"; // 引入我们的核心引擎

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

const CONFIG_FILE = path.join(os.homedir(), ".saber2pr-agent.json");

export default class McpAgent {
  private openai!: OpenAI;
  private modelName: string = "";
  private clients: Client[] = [];
  private allTools: ToolInfo[] = [];
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private engine: PromptEngine;

  constructor() {
    // 默认以当前工作目录为分析目标
    this.engine = new PromptEngine(process.cwd());

    this.messages.push({
      role: "system",
      content: `你是一个专业的 AI 代码架构师。
你可以访问本地文件系统并利用 AST (抽象语法树) 技术分析代码。
你的核心目标是提供准确的代码结构、依赖关系和逻辑分析。
请优先使用 read_skeleton 查看结构，只有在必要时才使用 read_full_code 或 get_method_body。`,
    });

    // 初始化内置工具
    this.registerBuiltinTools();
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
        _handler: async ({ filePath }) => this.engine.getSkeleton(filePath),
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
        _handler: async ({ filePath, methodName }) =>
          this.engine.getMethodImplementation(filePath, methodName),
      },
    ];

    this.allTools.push(...builtinTools);
  }

  // --- 初始化与环境准备 (API Config & MCP Servers) ---

  private async ensureApiConfig(): Promise<ApiConfig> {
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

  /**
   * 核心交互循环 (Reasoning Loop)
   * 允许 AI 连续调用工具来解决复杂代码问题
   */
  private async processChat(userInput: string) {
    this.messages.push({ role: "user", content: userInput });

    while (true) {
      const response = await this.openai.chat.completions.create({
        model: this.modelName,
        messages: this.messages,
        tools: this.allTools.map(
          ({ _handler, _client, _originalName, ...rest }) => rest,
        ) as any,
        tool_choice: "auto",
      });

      const message = response.choices[0].message;
      this.messages.push(message);

      if (!message.tool_calls) {
        console.log(`\n🤖 Agent: ${message.content}`);
        break;
      }

      console.log(`\n⚙️ 正在思考并执行 ${message.tool_calls.length} 个操作...`);

      for (const call of message.tool_calls) {
        const tool = this.allTools.find(
          (t) => t.function.name === call.function.name,
        );
        let result: any;

        if (tool?._handler) {
          // 执行内置 PromptEngine 工具
          result = await tool._handler(JSON.parse(call.function.arguments));
        } else if (tool?._client && tool._originalName) {
          // 执行外部 MCP 工具
          const mcpRes = await tool._client.callTool({
            name: tool._originalName,
            arguments: JSON.parse(call.function.arguments),
          });
          result = mcpRes.content;
        }

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
        console.log(`   - 完成: ${call.function.name}`);
      }
    }
  }

  async start() {
    await this.init();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    console.log(`\n🚀 代码助手已启动 (目标目录: ${this.engine.getRootDir()})`);

    const chatLoop = () => {
      rl.question("\n👤 你: ", async (input) => {
        if (input.toLowerCase() === "exit") process.exit(0);
        try {
          await this.processChat(input);
        } catch (err: any) {
          console.error("\n❌ 系统错误:", err.message);
        }
        chatLoop();
      });
    };
    chatLoop();
  }
}
