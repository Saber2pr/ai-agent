import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, END, START, Annotation, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";

import { createDefaultBuiltinTools } from "../tools/builtin";
import { AgentOptions } from "../types/type";
import { convertToLangChainTool } from "../utils/convertToLangChainTool";

export const CONFIG_FILE = path.join(os.homedir(), ".saber2pr-agent.json");

// ✅ 全局设置：修复 AbortSignal 监听器数量警告
// LangChain 的 HTTP 客户端会创建多个 AbortSignal，需要增加默认限制
EventEmitter.defaultMaxListeners = 100;

// --- 1. 定义接口 ---
interface TokenUsage {
  total: number;
}

// --- 2. 定义状态 (State) ---
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  auditedFiles: Annotation<string[]>({
    reducer: (x, y) => Array.from(new Set([...x, ...y])),
    default: () => [],
  }),
  targetCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 4,
  }),
  mode: Annotation<"chat" | "auto">({
    reducer: (x, y) => y ?? x,
    default: () => "chat",
  }),
  // ✅ Token 累加器
  tokenUsage: Annotation<TokenUsage>({
    reducer: (x, y) => ({
      total: (x?.total || 0) + (y?.total || 0),
    }),
    default: () => ({ total: 0 }),
  }),
  // ✅ 耗时累加器
  totalDuration: Annotation<number>({
    reducer: (x, y) => (x || 0) + (y || 0),
    default: () => 0,
  }),
});

export default class McpGraphAgent {
  private model: any;
  private toolNode: ToolNode;
  private targetDir: string;
  private options: AgentOptions;
  private checkpointer = new MemorySaver();
  private langchainTools: any[] = [];
  private stopLoadingFunc: (() => void) | null = null;
  private verbose: boolean;
  private alwaysSystem: boolean;
  private recursionLimit: number;
  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.verbose = options.verbose || false;
    this.alwaysSystem = options.alwaysSystem || true;
    this.targetDir = options.targetDir || process.cwd();
    this.recursionLimit = options.recursionLimit || 200;
    process.setMaxListeners(100);

    // ✅ 修复 AbortSignal 监听器数量警告
    // LangChain 的 HTTP 客户端会创建多个 AbortSignal，需要增加默认限制
    // 设置 EventEmitter 的默认 maxListeners，这会影响所有事件发射器（包括 AbortSignal）
    EventEmitter.defaultMaxListeners = 100;

    const cleanup = () => {
      this.stopLoading();
      process.stdout.write('\u001B[?25h');
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // ✅ 初始化内置工具
    const builtinToolInfos = createDefaultBuiltinTools({ options });
    this.langchainTools = [...builtinToolInfos, ...(options.tools || [])].map((t) =>
      convertToLangChainTool(t)
    );
    this.toolNode = new ToolNode(this.langchainTools);
  }

  private showLoading(text: string) {
    const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    process.stdout.write('\u001B[?25l');
    const timer = setInterval(() => {
      process.stdout.write(`\r\x1b[36m${chars[i]}\x1b[0m ${text}`);
      i = (i + 1) % chars.length;
    }, 80);
    return () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
      process.stdout.write('\u001B[?25h');
    };
  }

  private startLoading(text: string) {
    this.stopLoading();
    this.stopLoadingFunc = this.showLoading(text);
  }

  private stopLoading() {
    if (this.stopLoadingFunc) {
      this.stopLoadingFunc();
      this.stopLoadingFunc = null;
    }
  }

  private async getModel() {
    if (this.model) return this.model;
    let modelInstance = this.options.apiModel;
    if (!modelInstance) {
      const config = await this.askForConfig();
      modelInstance = new ChatOpenAI({
        openAIApiKey: config.apiKey,
        configuration: { baseURL: config.baseURL },
        modelName: config.model,
        temperature: 0,
      });
    }
    // 绑定工具，使模型具备调用能力
    this.model = modelInstance.bindTools(this.langchainTools);
    return this.model;
  }

  private async askForConfig() {
    let config: any = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch (e) { }
    }
    if (!config.baseURL || !config.apiKey) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = (q: string) => new Promise<string>((res) => rl.question(q, res));
      config.baseURL = config.baseURL || await question(`? API Base URL: `);
      config.apiKey = config.apiKey || await question(`? API Key: `);
      config.model = config.model || await question(`? Model Name: `) || "gpt-4o";
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      rl.close();
    }
    return config;
  }

  async chat(query: string = "开始代码审计") {
    await this.getModel();
    const app = await this.createGraph();
    const stream = await app.stream({
      messages: [new HumanMessage(query)],
      mode: "auto",
      targetCount: 4,
    }, { configurable: { thread_id: "auto_worker" }, recursionLimit: this.recursionLimit, debug: this.verbose, });

    for await (const output of stream) this.renderOutput(output);
  }

  async start() {
    await this.getModel();
    const app = await this.createGraph();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.on("SIGINT", () => {
      this.stopLoading();
      rl.close();
      process.stdout.write('\u001B[?25h');
      process.exit(0);
    });

    const ask = () => {
      rl.question("> ", async (input) => {
        if (input.toLowerCase() === "exit") { rl.close(); return; }
        const stream = await app.stream(
          { messages: [new HumanMessage(input)], mode: "chat" },
          { configurable: { thread_id: "session" }, recursionLimit: 50 }
        );
        for await (const output of stream) this.renderOutput(output);
        ask();
      });
    };
    ask();
  }

  private renderOutput(output: any) {
    this.stopLoading(); // 停止加载动画

    const agentNode = output.agent;

    // ✅ 打印工具执行结果（tools 节点的输出）
    const toolsNode = output.tools;
    if (toolsNode && toolsNode.messages) {
      const toolMessages = Array.isArray(toolsNode.messages) ? toolsNode.messages : [];

      // 获取最近的 AI 消息以匹配 tool_call_id
      const lastAiMsg = agentNode?.messages?.[agentNode.messages.length - 1] as AIMessage;
      const toolCallMap = new Map<string, string>();
      if (lastAiMsg?.tool_calls) {
        lastAiMsg.tool_calls.forEach((tc: any) => {
          if (tc.id) toolCallMap.set(tc.id, tc.name);
        });
      }

      toolMessages.forEach((msg: any) => {
        // ToolMessage 有 tool_call_id 字段
        const toolCallId = msg.tool_call_id || msg.id;
        if (toolCallId) {
          const toolName = toolCallMap.get(toolCallId) || msg.name || 'unknown';
          const content = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);

          // 如果内容太长，截断显示
          const displayContent = content.length > 500
            ? content.substring(0, 500) + '...'
            : content;

          console.log(`✅ [工具结果] ${toolName}: ${displayContent}`);
        }
      });
    }
    if (agentNode) {
      const msg = agentNode.messages[agentNode.messages.length - 1] as AIMessage;

      // 1. 打印思考过程（如果有）
      const reasoning = msg.additional_kwargs?.reasoning as string;
      if (reasoning) {
        console.log(`\n🧠 [思考]: ${reasoning}`);
      }

      // 2. 打印 AI 回复内容
      if (msg.content) {
        console.log(`🤖 [AI]: ${msg.content}`);
      }

      // ✅ 3. 实时打印当次统计信息
      // 这里的 meta 数据是从 AgentGraphModel 的 _generate 中塞进去的
      const meta = msg.response_metadata || {};
      const token = meta.token || 0;
      const duration = meta.duration || 0;

      if (token > 0 || duration > 0) {
        process.stdout.write(
          `📊 \x1b[2m[实时统计] 消耗: ${token} tokens | 耗时: ${duration}ms\x1b[0m\n`
        );
      }

      // 4. 打印工具调用情况
      if (msg.tool_calls?.length) {
        msg.tool_calls.forEach((call) => {
          console.log(`🛠️ [调用工具]: ${call.name} 📦 参数: ${JSON.stringify(call.args)}`);
        });
      }
    }
  }

  async callModel(state: typeof AgentState.State) {
    const auditedListStr = state.auditedFiles.length > 0
      ? state.auditedFiles.map(f => `\n  - ${f}`).join("")
      : "暂无";

    const recentToolCalls = this.getRecentToolCalls(state.messages);
    const recentToolCallsStr = recentToolCalls.length > 0
      ? `\n\n⚠️ 最近调用的工具（避免重复调用相同工具和参数）：\n${recentToolCalls.map(tc => `  - ${tc.name}(${JSON.stringify(tc.args)})`).join("\n")}`
      : "";

    // 1. 构建当前的系统提示词模板
    const systemPromptTemplate = `你是一个代码专家。工作目录：${this.targetDir}。
当前模式：{mode}
进度：{doneCount}/{targetCount}
已审计文件：{auditedList}

# 格式要求
1. Arguments 必须是纯粹的 JSON 对象，严禁将其作为字符串放入引号中。
2. 严禁对 JSON 内容进行二次转义。

# 指令
1. 避免陷入在同一个文件上的无限循环尝试。
2. 不要重复调用相同的工具和参数，如果工具已经返回结果，请基于结果继续工作而不是再次调用。{recentToolCalls}
{extraPrompt}`;

    // 2. 核心逻辑：处理消息上下文
    let inputMessages: BaseMessage[];

    // ✅ 检查 options 中的 alwaysSystem 参数 (默认为 true 或根据你的需求设置)
    // 如果不希望每次都携带（即只在首轮携带），则过滤掉历史消息里的 SystemMessage
    if (this.options.alwaysSystem === false) {
      inputMessages = state.messages.filter(msg => msg._getType() !== "system");
    } else {
      // 默认模式：保持干净，由 PromptTemplate 重新生成最新的 System 状态
      inputMessages = state.messages.filter(msg => msg._getType() !== "system");
    }

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", systemPromptTemplate],
      new MessagesPlaceholder("messages"),
    ]);

    this.startLoading("AI 正在分析并思考中");



    try {
      const chain = prompt.pipe(this.model);
      const response = await chain.invoke({
        messages: inputMessages, // ✅ 使用处理后的消息列表
        mode: state.mode,
        targetCount: state.targetCount,
        doneCount: state.auditedFiles.length,
        auditedList: auditedListStr,
        recentToolCalls: recentToolCallsStr,
        extraPrompt: this.options.extraSystemPrompt || "",
      });

      this.stopLoading();

      const meta = (response as any).response_metadata || {};
      const currentToken = Number(meta.token) || 0;
      const currentDuration = Number(meta.duration) || 0;

      return {
        messages: [response],
        tokenUsage: { total: currentToken },
        totalDuration: currentDuration
      };
    } catch (error) {
      this.stopLoading();
      throw error;
    }
  }

  private getRecentToolCalls(messages: BaseMessage[], limit: number = 5) {
    const toolCalls: Array<{ name: string; args: any }> = [];

    // 从后往前遍历消息，收集最近的工具调用
    for (let i = messages.length - 1; i >= 0 && toolCalls.length < limit; i--) {
      const msg = messages[i] as AIMessage;
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          toolCalls.push({ name: tc.name, args: tc.args });
          if (toolCalls.length >= limit) break;
        }
      }
    }

    return toolCalls;
  }

  async trackProgress(state: typeof AgentState.State) {
    const lastAiMsg = state.messages[state.messages.length - 1] as AIMessage;
    const currentAudited = new Set(state.auditedFiles);

    if (lastAiMsg?.tool_calls?.length) {
      for (const tc of lastAiMsg.tool_calls) {
        // 兼容所有可能的路径参数字段
        const file = tc.args.path || tc.args.filePath || tc.args.file || tc.args.file_path;
        if (file && typeof file === 'string') {
          currentAudited.add(file);
        }
      }
    }
    return { auditedFiles: Array.from(currentAudited) };
  }

  private printFinalSummary(state: typeof AgentState.State) {
    const totalTokens = state.tokenUsage?.total || 0;
    const totalMs = state.totalDuration || 0;

    if (totalTokens > 0 || totalMs > 0) {
      console.log("\n" + "═".repeat(50));
      console.log(`🏁 \x1b[32;1m[审计任务全量结算]\x1b[0m`);
      console.log(`   - 累计消耗总额: \x1b[33m${totalTokens}\x1b[0m Tokens`);
      console.log(`   - 累计执行耗时: \x1b[36m${(totalMs / 1000).toFixed(2)}\x1b[0m s`);
      console.log(`   - 审计文件总数: ${state.auditedFiles.length} 个`);
      console.log("═".repeat(50) + "\n");
    }
  }

  async createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode("agent", (state) => this.callModel(state))
      .addNode("tools", this.toolNode)
      .addNode("progress", (state) => this.trackProgress(state))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", (state) => {
        const messages = state.messages;
        const lastMsg = messages[messages.length - 1] as AIMessage;
        const content = (lastMsg.content as string) || "";

        // 1. 如果 AI 想要调用工具，去 tools 节点
        if (lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
          return "tools";
        }

        // 2. 判定结束的条件：
        // - 模式是 auto 且审计完成
        // - 或者 AI 明确输出了结束语
        // - 或者 AI 输出了普通内容且没有工具调用（针对问答模式）
        const isAutoFinished = state.mode === "auto" && state.auditedFiles.length >= state.targetCount;
        const isFinalAnswer = content.includes("Final Answer");

        // ✅ 修复核心：如果 AI 只是在聊天（没有工具调用），直接结束，不要跳回 agent
        if (isAutoFinished || isFinalAnswer || state.mode === "chat") {
          this.printFinalSummary(state);
          return END;
        }

        // 兜底：如果是在 auto 模式且还没干完活，才跳回 agent（通常不会走到这里）
        return END;
      })
      .addEdge("tools", "progress")
      .addEdge("progress", "agent");

    return workflow.compile({ checkpointer: this.checkpointer });
  }
}