import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import * as readline from "readline";

// --- Type Definitions ---
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
  _originalName: string;
  _client: Client;
}

const CONFIG_FILE = path.join(os.homedir(), ".saber2pr-agent.json");

// --- Core Class ---
export default class McpAgent {
  private openai!: OpenAI;
  private modelName: string = "";
  private clients: Client[] = [];
  private allTools: ToolInfo[] = [];
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  constructor() {
    this.messages.push({
      role: "system",
      content: "You are a powerful local assistant. You can access local tools provided by the user via the MCP protocol. Please answer questions by combining tool outputs and context.",
    });
  }

  /**
   * 1. API Configuration Management
   * Checks for existing config or prompts user for input.
   */
  private async ensureApiConfig(): Promise<ApiConfig> {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const config: ApiConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
        if (config.baseURL && config.apiKey && config.model) {
          return config;
        }
      } catch (e) {
        console.error(`[Error] Failed to read ${CONFIG_FILE}, re-initializing...`);
      }
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query: string) => new Promise<string>((resolve) => rl.question(query, resolve));

    console.log("\n🔑 API Configuration not found. Please provide the following details:");
    const baseURL = await question("? API Base URL: ");
    const apiKey = await question("? API Key: ");
    const model = await question("? Model Name: ");

    if (!baseURL || !apiKey || !model) {
      console.error("❌ Error: All fields (Base URL, API Key, Model Name) are required!");
      process.exit(1);
    }

    const config: ApiConfig = { baseURL, apiKey, model };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`✅ Configuration saved to ${CONFIG_FILE}\n`);
    rl.close();
    return config;
  }

  /**
   * 2. Load MCP server configs from common IDE paths
   */
  private loadMcpConfigs(): McpConfig {
    const combinedConfig: McpConfig = { mcpServers: {} };
    const configPaths = [
      path.join(os.homedir(), ".cursor", "mcp.json"),
      path.join(os.homedir(), ".vscode", "mcp.json"),
    ];

    for (const p of configPaths) {
      if (fs.existsSync(p)) {
        try {
          const content = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (content.mcpServers) {
            combinedConfig.mcpServers = { ...combinedConfig.mcpServers, ...content.mcpServers };
            console.log(`[MCP] Config loaded from: ${p}`);
          }
        } catch (e) {
          console.error(`[Error] Failed to parse MCP config ${p}:`, e);
        }
      }
    }
    return combinedConfig;
  }

  /**
   * 3. Initialization
   * Validates API credentials and connects to MCP servers.
   */
  async init() {
    // A. Setup & Validate OpenAI
    const apiConfig = await this.ensureApiConfig();
    this.openai = new OpenAI({
      baseURL: apiConfig.baseURL,
      apiKey: apiConfig.apiKey,
    });
    this.modelName = apiConfig.model;

    console.log("🔍 Validating API configuration...");
    try {
      // Perform a lightweight check to verify URL and Key
      await this.openai.models.list();
      console.log("✅ API validation successful.");
    } catch (e: any) {
      console.error("\n❌ API Connection Failed!");
      console.error(`Reason: ${e.message}`);
      console.log(`\nSuggestion: If you made a mistake, please delete or edit: ${CONFIG_FILE}`);
      process.exit(1);
    }

    // B. Setup MCP Clients
    const mcpConfig = this.loadMcpConfigs();
    const serverEntries = Object.entries(mcpConfig.mcpServers);

    if (serverEntries.length === 0) {
      console.warn("⚠️ No MCP server configurations found.");
    }

    for (const [name, server] of serverEntries) {
      try {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args || [],
          env: { ...process.env, ...(server.env || {}) } as any,
        });

        const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
        const { tools } = await client.listTools();

        const formatted = tools.map((t) => ({
          type: "function" as const,
          function: {
            name: `${name}__${t.name}`,
            description: t.description,
            parameters: t.inputSchema,
          },
          _originalName: t.name,
          _client: client,
        }));

        this.allTools.push(...formatted);
        this.clients.push(client);
        console.log(`✅ [${name}] Connected, loaded ${tools.length} tools`);
      } catch (e) {
        console.error(`❌ [${name}] Failed to start:`, e);
      }
    }
  }

  /**
   * 4. Core Chat Logic
   * Handles user input and recursive tool calls.
   */
  private async processChat(userInput: string) {
    this.messages.push({ role: "user", content: userInput });

    let isThinking = true;
    while (isThinking) {
      const apiTools = this.allTools.map(({ _originalName, _client, ...rest }) => rest);

      const response = await this.openai.chat.completions.create({
        model: this.modelName,
        messages: this.messages,
        tools: apiTools.length > 0 ? (apiTools as any) : undefined,
        tool_choice: "auto",
      });

      const message = response.choices[0].message;

      // If no more tool calls, exit loop and show final response
      if (!message.tool_calls || message.tool_calls.length === 0) {
        this.messages.push(message);
        console.log(`\n🤖 Agent: ${message.content}`);
        isThinking = false;
        break;
      }

      // Handle tool calls requested by the model
      this.messages.push(message);
      console.log(`\n⚙️  Model requested ${message.tool_calls.length} tool calls...`);

      for (const toolCall of message.tool_calls) {
        const toolInfo = this.allTools.find((t) => t.function.name === toolCall.function.name);

        if (toolInfo) {
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`   - Executing: ${toolInfo.function.name}`);

          try {
            const result = await toolInfo._client.callTool({
              name: toolInfo._originalName,
              arguments: args,
            });

            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result.content),
            });
          } catch (error: any) {
            console.error(`   - Execution failed: ${error.message}`);
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Error: ${error.message}`,
            });
          }
        }
      }
    }
  }

  /**
   * 5. Start the Interactive Shell
   */
  async start() {
    await this.init();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n🚀 Agent Started (Model: ${this.modelName})! Type 'exit' to quit.`);

    const chatLoop = () => {
      rl.question("\n👤 You: ", async (input) => {
        if (input.toLowerCase() === "exit") {
          console.log("Goodbye!");
          rl.close();
          process.exit(0);
        }

        try {
          await this.processChat(input);
        } catch (err: any) {
          console.error("\n❌ System Error during chat:", err.message);
          console.log("Try checking your API configuration or network connection.");
        }
        chatLoop();
      });
    };

    chatLoop();
  }
}