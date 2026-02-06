import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, END, START, Annotation, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";

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
    // 确保列表是累加且去重的
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
  
  // ✅ 存储清理 loading 的函数
  private stopLoadingFunc: (() => void) | null = null;

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.targetDir = options.targetDir || process.cwd();
    process.setMaxListeners(100);

    // ✅ 全局退出处理：清理动画并恢复光标
    const cleanup = () => {
      this.stopLoading();
      process.stdout.write('\u001B[?25h'); 
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    const builtinToolInfos = createDefaultBuiltinTools({ options });
    this.langchainTools = [...builtinToolInfos, ...(options.tools || [])].map((t) =>
      convertToLangChainTool(t)
    );
    this.toolNode = new ToolNode(this.langchainTools);
  }

  // ✅ 1. 核心 Loading 动画效果
  private showLoading(text: string) {
    const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    // 隐藏光标
    process.stdout.write('\u001B[?25l');
    const timer = setInterval(() => {
      process.stdout.write(`\r\x1b[36m${chars[i]}\x1b[0m ${text}`);
      i = (i + 1) % chars.length;
    }, 80);

    return () => { 
      clearInterval(timer); 
      process.stdout.write('\r\x1b[K'); // 清行
      process.stdout.write('\u001B[?25h'); // 恢复光标
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

  async chat(query: string = "开始代码审计") {
    await this.getModel();
    const app = await this.createGraph();
    const stream = await app.stream({
      messages: [new HumanMessage(query)],
      mode: "auto",
      targetCount: 4
    }, { configurable: { thread_id: "auto_worker" }, recursionLimit: 100 });

    for await (const output of stream) this.renderOutput(output);
    console.log("\n✅ 审计任务已完成。");
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

    console.log(`\n💬 已进入交互审计模式 (Thread: session)`);

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
    this.stopLoading(); // 收到输出的第一时间关掉 Loading

    // 1. 处理 Agent 节点的输出
    const agentNode = output.agent;
    if (agentNode) {
      const msg = agentNode.messages[0];
      const reasoning = msg.additional_kwargs?.reasoning;
      if (reasoning) {
        console.log("\n🧠 [思考过程]:\n" + "─".repeat(50) + "\n" + reasoning + "\n" + "─".repeat(50));
      }
      if (msg.content) console.log("🤖 [AI]:", msg.content);
      if (msg.tool_calls?.length) {
        msg.tool_calls.forEach((call: any) => {
          console.log(`🛠️ [调用工具]: ${call.name} 📦 参数: ${JSON.stringify(call.args)}`);
        });
      }
    }

    // 2. 处理工具节点的简要反馈（防止大数据量锁死终端）
    if (output.tools) {
      console.log(`✅ [工具执行完毕]`);
    }
  }

  async callModel(state: typeof AgentState.State) {
    const auditedListStr = state.auditedFiles.length > 0 
      ? state.auditedFiles.map(f => `\n  - ${f}`).join("") 
      : "暂无";

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", `你是一个代码专家。工作目录：${this.targetDir}。
当前模式：{mode}
进度：{doneCount}/{targetCount}
已审计文件：{auditedList}

# 指令
1. 优先通过 directory_tree 了解结构。
2. 发现问题后，先用 apply_fix 修复，再用 generate_review 提交。
3. 严禁反复执行同一个失败的操作。
{extraPrompt}`],
      new MessagesPlaceholder("messages"),
    ]);

    this.startLoading("AI 正在分析并思考中");

    try {
      const chain = prompt.pipe(this.model);
      const response = await chain.invoke({
        messages: state.messages,
        mode: state.mode,
        targetCount: state.targetCount,
        doneCount: state.auditedFiles.length,
        auditedList: auditedListStr,
        extraPrompt: this.options.extraSystemPrompt || "",
      });

      this.stopLoading();
      return { messages: [response] };
    } catch (error) {
      this.stopLoading();
      throw error;
    }
  }

  async trackProgress(state: typeof AgentState.State) {
    const lastAiMsg = state.messages[state.messages.length - 1] as AIMessage;
    const currentAudited = [...state.auditedFiles];

    if (lastAiMsg?.tool_calls?.length) {
      for (const tc of lastAiMsg.tool_calls) {
        // 兼容不同的参数命名习惯
        const file = tc.args.path || tc.args.filePath || tc.args.file;
        if (file && typeof file === 'string') {
          currentAudited.push(file);
        }
      }
    }
    // 注意：这里的 reducer 会自动帮我们处理去重
    return { auditedFiles: currentAudited };
  }

  async createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode("agent", (state) => this.callModel(state))
      .addNode("tools", this.toolNode)
      .addNode("progress", (state) => this.trackProgress(state))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", (state) => {
        const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
        
        // 1. 有工具调用，必须去 tools
        if (lastMsg.tool_calls?.length) return "tools";

        // 2. 自动模式下，如果审计文件数未达标，继续循环
        if (state.mode === "auto") {
          if (state.auditedFiles.length < state.targetCount) return "agent";
        }
        
        // 3. 默认结束（对话模式或任务已达标）
        return END;
      }, {
        tools: "tools",
        agent: "agent",
        [END]: END,
      })
      .addEdge("tools", "progress")
      .addEdge("progress", "agent"); // 闭环回到 agent 进行下一轮决策

    return workflow.compile({ checkpointer: this.checkpointer });
  }
}