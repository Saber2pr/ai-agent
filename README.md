# @saber2pr/ai-agent

A lightweight local AI assistant based on the **MCP (Model Context Protocol)**. It automatically loads your local tools (from Cursor or VSCode MCP configurations) and provides an intelligent orchestration layer via OpenAI-compatible APIs.

## ✨ Features

* **Native MCP Support**: Seamlessly connects to local MCP servers using Stdio transport.
* **Auto-Discovery**: Automatically reads tool definitions from `~/.cursor/mcp.json` and `~/.vscode/mcp.json`.
* **Persistent Configuration**: On the first run, it guides you through setting up your API endpoint, key, and model name, saving them to `~/.saber2pr-agent.json`.
* **Namespace Management**: Prevents tool name conflicts by automatically prefixing functions (e.g., `serverName__toolName`).
* **Interactive CLI**: Built-in REPL for multi-turn conversations and complex tool-chaining.

## 📦 Installation

Install globally via npm:

```bash
npm install -g @saber2pr/ai-agent
```

Or run directly using `npx`:

```bash
npx @saber2pr/ai-agent
```

## 🚀 Quick Start

### 1. Launch the Agent

Start the assistant by running the binary command:

```bash
sagent
```

### 2. Initialize Configuration

If it's your first time running the agent, you will be prompted to provide:

* **API Base URL**: e.g., `https://api.openai.com/v1` or your custom proxy.
* **API Key**: Your model provider's API key.
* **Model Name**: e.g., `gpt-4o`, `claude-3-5-sonnet`, or `deepseek-v3`.

Your settings will be stored in `~/.saber2pr-agent.json` for future use.

### 3. Connect Local Tools

The agent automatically scans the following paths for MCP configurations:

* `~/.cursor/mcp.json`
* `~/.vscode/mcp.json`

Ensure your MCP servers are configured in these files, and `sagent` will gain the ability to call them immediately.

## 🛠️ Usage

| Command                  | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `~/.saber2pr-agent.json` | Manually edit this file to update API settings. |
| `exit`                   | Type during a chat to quit the program.         |
| `sagent`                 | Enter interactive chat mode.                    |

## 🏗️ Tech Stack

Built with:

* [@modelcontextprotocol/sdk](https://www.google.com/search?q=https://github.com/modelcontextprotocol/typescript-sdk) - Official MCP SDK.
* [openai](https://www.google.com/search?q=https://github.com/openai/openai-node) - Client for API interactions.
* [TypeScript](https://www.google.com/search?q=https://www.typescriptlang.org/) - Ensuring type safety and robustness.

## 📄 License

[ISC](https://www.google.com/search?q=./LICENSE) © saber2pr
