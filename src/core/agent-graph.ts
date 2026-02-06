import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, END, START, Annotation, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";
import ora from "ora"; // 用于显示 Loading 动画

import { createDefaultBuiltinTools } from "../tools/builtin";
import { AgentOptions } from "../types/type";
import { convertToLangChainTool } from "../utils/convertToLangChainTool";

export const CONFIG_FILE = path.join(os.homedir(), ".saber2pr-agent.json");

// --- 1. 定义状态 (State) ---
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
});

export default class McpGraphAgent {
  private model: any;
  private toolNode: ToolNode;
  private targetDir: string;
  private options: AgentOptions;
  private checkpointer = new MemorySaver();
  private langchainTools: any[] = [];
  private spinner = ora({ color: "cyan" });

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.targetDir = options.targetDir || process.cwd();
    process.setMaxListeners(50); // 防止 AbortSignal 监听器过多的警告

    const builtinToolInfos = createDefaultBuiltinTools({ options });
    const externalToolInfos = options.tools || [];
    
    this.langchainTools = [...builtinToolInfos, ...externalToolInfos].map((t) =>
      convertToLangChainTool(t)
    );

    this.toolNode = new ToolNode(this.langchainTools);
  }

  private async askForConfig() {
    let config: any = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch (e) {}
    }
    if (!config.baseURL || !config.apiKey) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = (q: string) => new Promise<string>((res) => rl.question(q, res));
      console.log(`💡 首次运行请配置信息：`);
      config.baseURL = config.baseURL || await question(`? API Base URL: `);
      config.apiKey = config.apiKey || await question(`? API Key: `);
      config.model = config.model || await question(`? Model Name: `) || "gpt-4o";
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      rl.close();
    }
    return config;
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
    this.model = modelInstance.bindTools(this.langchainTools);
    return this.model;
  }

  async chat(query: string = "开始代码审计") {
    await this.getModel();
    const app = await this.createGraph();
    const stream = await app.stream({
      messages: [new HumanMessage(query)],
      mode: "auto",
      targetCount: 4
    }, { configurable: { thread_id: "auto_worker" }, recursionLimit: 100 });

    for await (const output of stream) this.renderOutput(output);
    console.log("✅ 任务执行完毕。");
  }

  async start() {
    await this.getModel();
    const app = await this.createGraph();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const threadId = `session_${Date.now()}`;

    console.log(`\n💬 已进入交互审计模式 (Thread: ${threadId})`);

    const ask = () => {
      rl.question("> ", async (input) => {
        if (input.toLowerCase() === "exit") { rl.close(); return; }
        const stream = await app.stream(
          { messages: [new HumanMessage(input)], mode: "chat" },
          { configurable: { thread_id: threadId }, recursionLimit: 50 }
        );
        for await (const output of stream) this.renderOutput(output);
        ask();
      });
    };
    ask();
  }

  private renderOutput(output: any) {
    // 每次渲染输出前，确保停止 Spinner
    if (this.spinner.isSpinning) this.spinner.stop();

    const agentNode = output.agent;
    if (agentNode) {
      const msg = agentNode.messages[0];
      
      // 1. 打印思考过程
      const reasoning = msg.additional_kwargs?.reasoning;
      if (reasoning) {
        console.log("\n🧠 [思考过程]:\n" + "─".repeat(50) + "\n" + reasoning + "\n" + "─".repeat(50) + "\n");
      }

      // 2. 打印正式回答
      if (msg.content) console.log("🤖 [AI]:", msg.content);

      // 3. 打印工具调用
      if (msg.tool_calls?.length) {
        msg.tool_calls.forEach((call: any) => {
          console.log(`🛠️ [调用工具]: ${call.name} 📦 参数: ${JSON.stringify(call.args)}`);
        });
      }
    }
  }

  // --- 节点逻辑 ---

  async callModel(state: typeof AgentState.State) {
    // 处理变量序列化，防止 [object Object]
    const auditedListStr = state.auditedFiles.length > 0 
      ? state.auditedFiles.map(f => `\n  - ${f}`).join("") 
      : "暂无";

    const extraPromptStr = typeof this.options.extraSystemPrompt === 'object'
      ? JSON.stringify(this.options.extraSystemPrompt, null, 2)
      : (this.options.extraSystemPrompt || "");

    // 使用变量占位符 {extraPrompt} 避免内容中的 {} 引发模板解析错误
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", `你是一个代码审计专家。工作目录：${this.targetDir}。
当前模式：{mode}。
KPI进度：{doneCount}/{targetCount}。已审计文件：{auditedList}

# 附加指令
{extraPrompt}`],
      new MessagesPlaceholder("messages"),
    ]);

    // ✅ 显示 Loading
    this.spinner.start("AI 正在思考并分析代码...");

    try {
      const chain = prompt.pipe(this.model);
      const response = await chain.invoke({
        messages: state.messages,
        mode: state.mode,
        targetCount: state.targetCount,
        doneCount: state.auditedFiles.length,
        auditedList: auditedListStr,
        extraPrompt: extraPromptStr, // 变量方式传入更安全
      });

      this.spinner.stop(); // 得到响应即停止
      return { messages: [response] };
    } catch (error) {
      this.spinner.fail("AI 响应异常");
      throw error;
    }
  }

  async trackProgress(state: typeof AgentState.State) {
    const lastAiMsg = state.messages[state.messages.length - 1] as AIMessage;
    const newFiles: string[] = [];
    if (lastAiMsg?.tool_calls) {
      for (const tc of lastAiMsg.tool_calls) {
        // 追踪涉及写、修复、生成审计报告的文件
        const toolsToTrack = ["write_text_file", "apply_fix", "generate_review"];
        if (toolsToTrack.includes(tc.name)) {
          const file = tc.args.path || tc.args.filePath || tc.args.file;
          if (file && typeof file === 'string') newFiles.push(file);
        }
      }
    }
    return { auditedFiles: newFiles };
  }

  async createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode("agent", (state) => this.callModel(state))
      .addNode("tools", this.toolNode)
      .addNode("progress", (state) => this.trackProgress(state))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", (state) => {
        const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
        if (lastMsg.tool_calls?.length) return "tools";
        // 自动模式下且未达标时继续
        if (state.mode === "auto" && state.auditedFiles.length < state.targetCount) return "agent";
        return END;
      })
      .addEdge("tools", "progress")
      .addEdge("progress", "agent");

    return workflow.compile({ checkpointer: this.checkpointer });
  }
}