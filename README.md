# @saber2pr/ai-agent

A lightweight local AI assistant and automation audit engine based on the **MCP (Model Context Protocol)**. It integrates a powerful built-in AST engine with external MCP tool discovery to provide deep source code analysis and automated workflows.

## ✨ Features

* **Dual-Layer Tool Architecture**:
* **Built-in AST Engine**: High-performance analysis via `get_repo_map`, `read_skeleton`, and dependency mapping without needing external services.
* **External MCP Support**: Automatically connects to local MCP servers defined in `~/.cursor/mcp.json` or `~/.vscode/mcp.json`.


* **Extensible Logic**: Inject custom business rules via `extraSystemPrompt` and define specialized handlers through `customTools` (e.g., for automated Merge Request reviews).
* **Intelligent Context Management**:
* **Token Guard**: Automatically intercepts large file reads to prevent context overflow.
* **Dynamic Pruning**: Automatically prunes older message history when `maxTokens` is reached, ensuring the System Prompt and latest context remain intact.


* **Programmatic API**: Built-in `agent.chat()` method for seamless integration into CI/CD pipelines or automated scripts.

## 🚀 Quick Start

### 1. Installation

```bash
npm install -g @saber2pr/ai-agent

```

### 2. Interactive CLI Mode

Launch the assistant to configure API credentials and start chatting with your local tools:

```bash
sagent

```

### 3. Programmatic Integration (Automated Audit)

Use the agent as a library to perform structured code reviews:

```typescript
import McpAgent from "@saber2pr/ai-agent";

async function runReview() {
  const agent = new McpAgent({
    targetDir: "./my-project",
    maxTokens: 50000, 
    extraSystemPrompt: "You are a Senior Architect. Identify any hardcoded color values.",
    tools: [{
      name: "generate_review",
      description: "Submit a structured review report",
      parameters: { /* Your IAiViolation schema */ },
      handler: async (args) => { console.log("Reported Issues:", args); }
    }]
  });

  // Trigger one-shot analysis
  await agent.chat("Analyze the src directory and report all hardcoded colors.");
}

```

## 🛠️ Core Toolkit

| Tool              | Description                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `analyze_deps`    | Analyzes file dependencies with support for `tsconfig` path aliases.                                                 |
| `get_method_body` | Precisely extracts the implementation of a specific function or method.                                              |
| `get_repo_map`    | **Mandatory First Step**. Retrieves global file structure and exports to establish a project mental map.             |
| `read_full_code`  | Reads full source code with line numbers. Includes built-in token overflow protection.                               |
| `read_skeleton`   | Extracts interfaces, classes, and function signatures. **Token efficient**; highly recommended for initial analysis. |

## ⚙️ Configuration

Pass the following options when instantiating `McpAgent`:

```typescript
interface AgentOptions {
  targetDir?: string;        // Project root directory (default: process.cwd())
  tools?: CustomTool[];      // Custom tool extensions
  extraSystemPrompt?: any;   // Business rules or persona definitions
  maxTokens?: number;        // Context token limit (default: 100,000)
}

```

## 🏗️ Technical Implementation

The agent uses a "Windowing" strategy for context management. When `maxTokens` is exceeded, it removes older messages starting from index 1, ensuring that the critical instructions in the System Prompt (index 0) are never lost.

## 📄 License

[ISC](https://www.google.com/search?q=./LICENSE) © saber2pr
