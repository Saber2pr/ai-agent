import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createDefaultBuiltinTools } from '../tools/builtin';
import { ApiConfig, GraphAgentOptions, McpConfig, ToolInfo } from '../types/type';
import { convertToLangChainTool } from '../utils/convertToLangChainTool';
import { jsonSchemaToZod } from '../utils/jsonSchemaToZod';
import { formatSchema } from '../utils/formatSchema';
import { AgentGraphModel } from '../model/AgentGraphModel';
import { CONFIG_FILE } from '../config/config';

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
  mode: Annotation<'chat' | 'auto'>({
    reducer: (x, y) => y ?? x,
    default: () => 'chat',
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

export default class McpGraphAgent<T extends AgentGraphModel = any> {
  private model: T;
  private toolNode: ToolNode;
  private targetDir: string;
  private options: GraphAgentOptions;
  private checkpointer = new MemorySaver();
  private langchainTools: any[] = [];
  private stopLoadingFunc: (() => void) | null = null;
  private verbose: boolean;
  private alwaysSystem: boolean;
  private recursionLimit: number;
  private apiConfig: ApiConfig;
  private maxTargetCount: number;
  private maxTokens: number;
  private mcpClients: Client[] = [];
  private streamEnabled: boolean;

  constructor(options: GraphAgentOptions<T> = {}) {
    this.options = options;
    this.verbose = options.verbose || false;
    this.alwaysSystem = options.alwaysSystem || true;
    this.targetDir = options.targetDir || process.cwd();
    this.recursionLimit = options.recursionLimit || 80;
    this.apiConfig = options.apiConfig;
    this.maxTargetCount = options.maxTargetCount || 4;
    this.maxTokens = options.maxTokens || 8000;
    this.streamEnabled = options.stream || false;
    process.setMaxListeners(100);

    // ✅ 修复 AbortSignal 监听器数量警告
    // LangChain 的 HTTP 客户端会创建多个 AbortSignal，需要增加默认限制
    // 设置 EventEmitter 的默认 maxListeners，这会影响所有事件发射器（包括 AbortSignal）
    EventEmitter.defaultMaxListeners = 100;

    const cleanup = async () => {
      this.stopLoading();
      await this.closeMcpClients(); // 清理 MCP 连接
      process.stdout.write('\u001B[?25h');
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  private printLoadedTools() {
    console.log('\n🛠️  [Graph] 正在加载工具节点...');

    this.langchainTools.forEach((tool: any) => {
      // 工具名称
      console.log(`\n🧰 工具名: ${tool.name}`);

      // 提取参数结构 (LangChain Tool 的 schema 是 Zod 对象)
      const { schema } = tool;

      if (schema && schema.shape) {
        // 如果是 ZodObject，打印其内部 key
        console.log(`   参数结构:\n${formatSchema(schema)}`);
      } else if (schema && schema._def) {
        // 兼容其他 Zod 类型
        console.log(`   参数类型: ${schema._def.typeName}`);
      } else {
        // 降级：如果已经是 JSON 对象
        console.log(`   参数结构:`, JSON.stringify(schema, null, 2));
      }
    });

    console.log(`\n✅ Graph 节点就绪，总计加载 ${this.langchainTools.length} 个工具。\n`);
  }

  private loadMcpConfigs(): McpConfig {
    const combined: McpConfig = { mcpServers: {} };
    const paths = [
      path.join(os.homedir(), '.cursor', 'mcp.json'),
      path.join(os.homedir(), '.vscode', 'mcp.json'),
    ];
    paths.forEach(p => {
      if (fs.existsSync(p)) {
        const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
        Object.assign(combined.mcpServers, content.mcpServers);
      }
    });
    return combined;
  }

  private async initMcpTools() {
    const mcpConfig = this.loadMcpConfigs();
    const mcpServers = mcpConfig.mcpServers || {};
    const mcpToolInfos: ToolInfo[] = [];

    for (const [name, config] of Object.entries(mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...process.env, ...(config.env || {}) } as any,
        });

        const client = new Client(
          { name: 'mcp-graph-client', version: '1.0.0' },
          { capabilities: {} }
        );

        await client.connect(transport);
        this.mcpClients.push(client);

        const { tools } = await client.listTools();

        tools.forEach(tool => {
          mcpToolInfos.push({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: jsonSchemaToZod(tool.inputSchema), // MCP 使用 JSON Schema
            },
            _handler: async args => {
              const result = await client.callTool({
                name: tool.name,
                arguments: args,
              });
              return result.content;
            },
          });
        });
        console.log(`\n✅ 已连接 MCP 服务 [${name}]: 加载了 ${tools.length} 个工具`);
      } catch (error) {
        console.error(`\n❌ 连接 MCP 服务 [${name}] 失败:`, error.message);
      }
    }
    return mcpToolInfos;
  }

  private async prepareTools() {
    const builtinToolInfos = createDefaultBuiltinTools({ options: this.options });
    const mcpToolInfos = await this.initMcpTools();

    // 合并内置、手动传入和 MCP 工具
    const allToolInfos = [...builtinToolInfos, ...(this.options.tools || []), ...mcpToolInfos];

    this.langchainTools = allToolInfos.map(t => convertToLangChainTool(t));
    this.toolNode = new ToolNode(this.langchainTools);
  }

  // ✅ 修改：初始化逻辑
  async ensureInitialized() {
    if (this.model && this.langchainTools.length > 0) return;

    // 1. 加载所有工具（含 MCP）
    await this.prepareTools();

    // 2. 初始化模型
    await this.getModel();

    // 3. 打印工具状态
    this.printLoadedTools();
  }

  // ✅ 新增：关闭连接
  private async closeMcpClients() {
    for (const client of this.mcpClients) {
      try {
        await client.close();
      } catch (e) { }
    }
    this.mcpClients = [];
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

  async getModel() {
    if (this.model) return this.model;
    let modelInstance: any = this.options.apiModel;
    if (!modelInstance) {
      const config = await this.askForConfig();
      modelInstance = new ChatOpenAI({
        openAIApiKey: config.apiKey,
        configuration: { baseURL: config.baseURL },
        modelName: config.model,
        temperature: 0,
        maxTokens: this.maxTokens,
      });
    }
    this.model = modelInstance.bindTools(this.langchainTools);
    return this.model;
  }

  private async askForConfig() {
    if (this.apiConfig) return this.apiConfig;
    let config: any = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      } catch (e) { }
    }
    if (!config.baseURL || !config.apiKey) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = (q: string) => new Promise<string>(res => rl.question(q, res));
      config.baseURL = config.baseURL || (await question(`? API Base URL: `));
      config.apiKey = config.apiKey || (await question(`? API Key: `));
      config.model = config.model || (await question(`? Model Name: `)) || 'gpt-4o';
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      rl.close();
    }
    return config;
  }

  async chat(query = '开始代码审计') {
    try {
      await this.ensureInitialized();
      await this.getModel();
      const app = await this.createGraph();
      const graphStream = await app.stream(
        {
          messages: [new HumanMessage(query)],
          mode: 'auto',
          targetCount: this.maxTargetCount,
        },
        {
          configurable: { thread_id: 'auto_worker' },
          recursionLimit: this.recursionLimit,
          debug: this.verbose,
        }
      );

      for await (const output of graphStream) this.renderOutput(output, this.streamEnabled);
    } catch (error) {
      console.error('\n❌ Chat 过程中发生错误:', error);
    } finally {
      await this.closeMcpClients();
    }
  }

  /**
   * 流式执行单次查询（编程式 API）。
   * 无论 options.stream 是否开启，此方法始终以流式方式输出。
   */
  async stream(query = '开始代码审计') {
    const prevStream = this.streamEnabled;
    this.streamEnabled = true;
    try {
      await this.ensureInitialized();
      await this.getModel();
      const app = await this.createGraph();
      const graphStream = await app.stream(
        {
          messages: [new HumanMessage(query)],
          mode: 'auto',
          targetCount: this.maxTargetCount,
        },
        {
          configurable: { thread_id: 'stream_worker' },
          recursionLimit: this.recursionLimit,
          debug: this.verbose,
        }
      );

      for await (const output of graphStream) this.renderOutput(output, true);
    } catch (error) {
      console.error('\n❌ Stream 过程中发生错误:', error);
    } finally {
      this.streamEnabled = prevStream;
      await this.closeMcpClients();
    }
  }

  async start() {
    await this.ensureInitialized();
    await this.getModel();
    const app = await this.createGraph();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.on('SIGINT', () => {
      this.stopLoading();
      rl.close();
      process.stdout.write('\u001B[?25h');
      process.exit(0);
    });

    const ask = () => {
      rl.question('> ', async input => {
        if (input.toLowerCase() === 'exit') {
          rl.close();
          return;
        }
        const graphStream = await app.stream(
          { messages: [new HumanMessage(input)], mode: 'chat' },
          {
            configurable: { thread_id: 'session' },
            recursionLimit: this.recursionLimit,
            debug: this.verbose,
          }
        );
        for await (const output of graphStream) this.renderOutput(output, this.streamEnabled);
        ask();
      });
    };
    ask();
  }

  private renderOutput(output: any, isStreaming = false) {
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
          const content =
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

          // 如果内容太长，截断显示
          const displayContent = content.length > 500 ? content.substring(0, 500) + '...' : content;

          console.log(`✅ [工具结果] ${toolName}: ${displayContent}`);
        }
      });
    }
    if (agentNode) {
      const msg = agentNode.messages[agentNode.messages.length - 1] as AIMessage;

      // 1. 打印思考过程（如果有）
      // 流式模式下思考内容可能已经随流输出，此处仅在非流式模式或有独立 reasoning 字段时打印
      const reasoning = msg.additional_kwargs?.reasoning as string;
      if (reasoning && !isStreaming) {
        console.log(`\n🧠 [思考]: ${reasoning}`);
      }

      // 2. 打印 AI 回复内容（流式模式下已在 callModel 中逐字输出，跳过）
      if (msg.content && !isStreaming) {
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
        msg.tool_calls.forEach(call => {
          console.log(`🛠️ [调用工具]: ${call.name} 📦 参数: ${JSON.stringify(call.args)}`);
        });
      }
    }
  }

  async callModel(state: typeof AgentState.State) {
    const auditedListStr =
      state.auditedFiles.length > 0 ? state.auditedFiles.map(f => `\n  - ${f}`).join('') : '暂无';

    const recentToolCalls = this.getRecentToolCalls(state.messages);
    const recentToolCallsStr =
      recentToolCalls.length > 0
        ? `\n\n⚠️ 最近调用的工具（避免重复调用相同工具和参数）：\n${recentToolCalls
          .map(tc => `  - ${tc.name}(${JSON.stringify(tc.args)})`)
          .join('\n')}`
        : '';

    // 1. 构建当前的系统提示词模板
    const systemPromptTemplate = `你是一个代码专家。工作目录：${this.targetDir}。
当前模式：{mode}
进度：{doneCount}/{targetCount}
已审计文件：{auditedList}

# 🛠️ 工具调用规范
1. Arguments 必须是纯粹的 JSON 对象，严禁将其作为字符串放入引号中。
2. 严禁对 JSON 内容进行二次转义。
3. **禁止空操作**：如果你认为任务已完成或不需要调用工具，请不要输出任何 Action 结构。严禁使用 "None"、"null" 或空字符串作为工具名称。

# 🎯 核心指令
1. **任务终结判定**：当你已经读取了用户要求的文件、回答了问题或完成了审计目标时，必须立即提供最终回复。
2. **回复格式**：任务完成时，请以 "Final Answer:" 开头进行总结，此时不再调用任何工具。

# 📝 审计任务专项
1. 避免在同一个文件上陷入无限循环尝试。
2. 优先通过 \`list_directory\` 了解全局，再深入具体文件。
{extraPrompt}`;

    // 2. 核心逻辑：处理消息上下文
    let inputMessages: BaseMessage[];

    // ✅ 检查 options 中的 alwaysSystem 参数 (默认为 true 或根据你的需求设置)
    // 如果不希望每次都携带（即只在首轮携带），则过滤掉历史消息里的 SystemMessage
    if (this.options.alwaysSystem === false) {
      inputMessages = state.messages.filter(msg => msg._getType() !== 'system');
    } else {
      // 默认模式：保持干净，由 PromptTemplate 重新生成最新的 System 状态
      inputMessages = state.messages.filter(msg => msg._getType() !== 'system');
    }

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', systemPromptTemplate],
      new MessagesPlaceholder('messages'),
    ]);

    this.startLoading('AI 正在分析并思考中');

    try {
      const promptParams = {
        messages: inputMessages,
        mode: state.mode,
        targetCount: state.targetCount,
        doneCount: state.auditedFiles.length,
        auditedList: auditedListStr,
        recentToolCalls: recentToolCallsStr,
        extraPrompt: this.options.extraSystemPrompt || '',
      };

      if (this.streamEnabled) {
        // ✅ 流式模式：通过 AgentGraphModel.streamGenerate 进行流式输出
        const formattedMessages = await prompt.formatMessages(promptParams);
        this.stopLoading();

        // --- 流式 <think> 标签实时过滤 + 流式打印思考内容 ---
        const THINK_OPEN = '<think>';
        const THINK_CLOSE = '</think>';
        let inThink = false;
        let textBuffer = '';
        let aiHeaderPrinted = false;
        let thinkHeaderPrinted = false;

        const flushText = (text: string) => {
          if (!text) return;
          if (!aiHeaderPrinted) {
            process.stdout.write('🤖 [AI]: ');
            aiHeaderPrinted = true;
          }
          process.stdout.write(text);
        };

        const flushThink = (text: string) => {
          if (!text) return;
          if (!thinkHeaderPrinted) {
            process.stdout.write('\x1b[2m🧠 [思考]: ');
            thinkHeaderPrinted = true;
          }
          process.stdout.write(text);
        };

        const onChunk = (chunk: string) => {
          textBuffer += chunk;

          let processing = true;
          while (processing) {
            if (inThink) {
              // 在 <think> 块内，寻找 </think>
              const closeIdx = textBuffer.indexOf(THINK_CLOSE);
              if (closeIdx !== -1) {
                // 流式打印 </think> 之前的思考内容
                flushThink(textBuffer.slice(0, closeIdx));
                textBuffer = textBuffer.slice(closeIdx + THINK_CLOSE.length);
                inThink = false;
                // 思考块结束：换行 + 重置样式
                if (thinkHeaderPrinted) {
                  process.stdout.write('\x1b[0m\n');
                  thinkHeaderPrinted = false;
                }
              } else {
                // 未找到闭合标签，安全输出可确认部分（防止 </think> 跨 chunk 截断）
                const safeLen = Math.max(0, textBuffer.length - (THINK_CLOSE.length - 1));
                flushThink(textBuffer.slice(0, safeLen));
                textBuffer = textBuffer.slice(safeLen);
                processing = false;
              }
            } else {
              // 不在 <think> 块内，寻找 <think>
              const openIdx = textBuffer.indexOf(THINK_OPEN);
              if (openIdx !== -1) {
                flushText(textBuffer.slice(0, openIdx));
                textBuffer = textBuffer.slice(openIdx + THINK_OPEN.length);
                inThink = true;
              } else {
                // 未找到开启标签，安全输出可确认部分（防止 <think> 跨 chunk 截断）
                const safeLen = Math.max(0, textBuffer.length - (THINK_OPEN.length - 1));
                flushText(textBuffer.slice(0, safeLen));
                textBuffer = textBuffer.slice(safeLen);
                processing = false;
              }
            }
          }
        };

        const result = await (this.model as any).streamGenerate(formattedMessages, onChunk);

        // 刷新残留缓冲
        if (textBuffer) {
          if (inThink) {
            flushThink(textBuffer);
          } else {
            flushText(textBuffer);
          }
        }
        // 收尾：关闭思考块样式 / AI 输出换行
        if (thinkHeaderPrinted) {
          process.stdout.write('\x1b[0m\n');
        }
        if (aiHeaderPrinted) process.stdout.write('\n');

        const aiMsg = result.generations[0].message as AIMessage;
        const meta = aiMsg.response_metadata || {};
        const currentToken = Number(meta.token) || 0;
        const currentDuration = Number(meta.duration) || 0;

        return {
          messages: [aiMsg],
          tokenUsage: { total: currentToken },
          totalDuration: currentDuration,
        };
      }

      // 非流式模式（原有逻辑）
      const chain = prompt.pipe(this.model);
      const response = await chain.invoke(promptParams);

      this.stopLoading();

      const meta = (response as any).response_metadata || {};
      const currentToken = Number(meta.token) || 0;
      const currentDuration = Number(meta.duration) || 0;

      return {
        messages: [response],
        tokenUsage: { total: currentToken },
        totalDuration: currentDuration,
      };
    } catch (error) {
      this.stopLoading();
      throw error;
    }
  }

  private getRecentToolCalls(messages: BaseMessage[], limit = 5) {
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
      console.log('\n' + '═'.repeat(50));
      console.log(`🏁 \x1b[32;1m[审计任务全量结算]\x1b[0m`);
      console.log(`   - 累计消耗总额: \x1b[33m${totalTokens}\x1b[0m Tokens`);
      console.log(`   - 累计执行耗时: \x1b[36m${(totalMs / 1000).toFixed(2)}\x1b[0m s`);
      console.log(`   - 审计文件总数: ${state.auditedFiles.length} 个`);
      console.log('═'.repeat(50) + '\n');
    }
  }

  async createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode('agent', state => this.callModel(state))
      .addNode('tools', this.toolNode)
      .addNode('progress', state => this.trackProgress(state))
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', state => {
        const { messages } = state;
        const lastMsg = messages[messages.length - 1] as AIMessage;
        const content = (lastMsg.content as string) || '';

        // 🛑 新增：全局 Token 熔断保护
        // 如果已消耗 Token 超过了 options 中设置的 maxTokens (假设是总限额)
        if (this.options.maxTokens && state.tokenUsage.total >= this.options.maxTokens) {
          console.warn('⚠️ [警告] 已达到最大 Token 限制，强制结束任务。');
          this.printFinalSummary(state);
          return END;
        }

        // 1. 如果 AI 想要调用工具，去 tools 节点
        if (lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
          return 'tools';
        }

        // 2. 判定结束的条件：
        // - 模式是 auto 且审计完成
        // - 或者 AI 明确输出了结束语
        // - 或者 AI 输出了普通内容且没有工具调用（针对问答模式）
        const isAutoFinished =
          state.mode === 'auto' && state.auditedFiles.length > state.targetCount;
        const isFinalAnswer = content.includes('Final Answer');

        // ✅ 修复核心：如果 AI 只是在聊天（没有工具调用），直接结束，不要跳回 agent
        if (isAutoFinished || isFinalAnswer || state.mode === 'chat') {
          this.printFinalSummary(state);
          return END;
        }

        // 兜底：如果是在 auto 模式且还没干完活，才跳回 agent（通常不会走到这里）
        return END;
      })
      .addEdge('tools', 'progress')
      .addEdge('progress', 'agent');

    return workflow.compile({ checkpointer: this.checkpointer });
  }
}
