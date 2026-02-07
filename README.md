# 🤖 AI-Agent

A professional code architect assistant built with **Model Context Protocol (MCP)** and **LangGraph**. It bridges Large Language Models (LLMs) with local file systems and remote services through standardized workflows.

## 🌟 Core Modes

This project provides two core interaction modes to adapt to different LLM capabilities:

### 1. 🚀 Standard Agent (`sagent`)

**Best for**: Modern models that support native `tools` parameters (e.g., GPT-4o, Claude 3.5, Qwen-Max).

* **Native Function Calling**: Leverages the model's built-in tool-calling capabilities for precise parameter parsing and low latency.
* **Intuitive Interaction**: A classic Chat loop suitable for instant Q&A, quick code lookups, or single-file refactoring tasks.

### 2. 🏗️ Graph Agent (`sagent-graph`)

**Best for**: Long-running automated audits or scenarios where the API does not support native `tools`.

* **State Machine Architecture**: Built on **LangGraph** to implement an automated "Think-Act-Observe-Summarize" loop.
* **Audit Tracking**: Built-in progress manager that automatically records analyzed files to prevent redundant analysis in complex projects.
* **Auto-Settlement**: Automatically summarizes and prints **Total Tokens** and execution duration upon task completion or manual exit.

---

## 🛠️ Built-in Toolset

The Agent comes pre-installed with a suite of tools specifically customized for **code architecture analysis**:

| Category         | Tool Name         | Description                                                               |
| ---------------- | ----------------- | ------------------------------------------------------------------------- |
|                  | `list_directory`  | Lists files in a specified directory.                                     |
|                  | `analyze_deps`    | Analyzes import dependencies of a specific file.                          |
|                  | `read_skeleton`   | Reads only code skeletons (class names/signatures) to save tokens.        |
|                  | `edit_file`       | Precise Diff-based editing to avoid rewriting large files.                |
|                  | `get_method_body` | Precisely extracts the implementation of a specific method.               |
|                  | `get_file_info`   | Gets file metadata like size, permissions, and timestamps.                |
| **Architecture** | `get_repo_map`    | **Core**: Extracts export definitions and builds a module dependency map. |
| **General**      | `search_files`    | Performs a global keyword search across the project.                      |
| **Navigation**   | `directory_tree`  | Recursively gets the project structure (The entry point for analysis).    |
| **Operations**   | `read_text_file`  | Reads file content (supports pagination via head/tail).                   |

---

## 💻 CLI Guide

### Installation & Build

```bash
yarn
yarn build
```

### Usage

```sh
sudo npm i -g @saber2pr/ai-agent

```

* **Start Standard Chat**:
```bash
sagent
```


* **Start Automated Audit**:
```bash
sagent-graph
```

---

## ⚙️ Configuration

On the first run, the program will prompt you to configure `~/.saber2pr-agent.json`. You can define your API keys and dynamically connect **MCP Servers** here:

```json
{
  "baseURL": "https://api.example.com/v1",
  "apiKey": "sk-your-key",
  "model": "gpt-4o"
}

```

---

## 🔄 Professional Audit Workflow

Regardless of the mode, the Agent follows a standardized logic chain:

1. **Phase 1: Panoramic Perception (Where)**: Uses `directory_tree` to identify project layout (e.g., Monorepo vs. traditional src structure).
2. **Phase 2: Logic Mapping (What)**: Uses `get_repo_map` to establish logical relationships—understanding "who calls whom."
3. **Phase 3: Source Diving (How)**: Locates critical implementations and performs detailed auditing via `read_text_file` or specific extraction tools.

---

## 📄 License

ISC
