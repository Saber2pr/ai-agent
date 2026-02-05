import fs from 'fs';
import path from 'path';
import { AgentOptions, ToolInfo } from '../types/type';
import { PromptEngine } from '@saber2pr/ts-context-mcp';

export interface BuiltinToolsContext {
  options?: AgentOptions;
  /** 可选：获取当前已用 token 数 */
  getCurrentTokens?: () => number;
}

export function createDefaultBuiltinTools(context: BuiltinToolsContext): ToolInfo[] {
  const { options, getCurrentTokens } = context;

  const engine = new PromptEngine(options?.targetDir || process.cwd());
  const maxTokens = options?.maxTokens || 100000;

  const rootDir = () => engine.getRootDir();

  return [
    {
      type: "function",
      function: {
        name: "get_repo_map",
        description: "获取项目全局文件结构及导出清单，用于快速定位代码",
        parameters: { type: "object", properties: {} },
      },
      _handler: async () => {
        engine.refresh();
        return engine.getRepoMap();
      },
    },
    {
      type: "function",
      function: {
        name: "analyze_deps",
        description: "分析指定文件的依赖关系，支持 tsconfig 路径别名解析",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string", description: "文件相对路径" } },
          required: ["filePath"],
        },
      },
      _handler: async ({ filePath }: any) => engine.getDeps(filePath),
    },
    {
      type: "function",
      function: {
        name: "read_skeleton",
        description: "提取文件的结构定义（接口、类、方法签名），忽略具体实现以节省 Token",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string", description: "文件相对路径" } },
          required: ["filePath"],
        },
      },
      _handler: async (args: any) => {
        const pathArg = args?.filePath;
        if (typeof pathArg !== "string" || pathArg.trim() === "") {
          return `Error: 参数 'filePath' 无效。收到的是: ${JSON.stringify(pathArg)}`;
        }
        try {
          engine.refresh();
          const result = engine.getSkeleton(pathArg);
          return result || `// Warning: 文件 ${pathArg} 存在但未找到任何可提取的结构。`;
        } catch (error: any) {
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
      _handler: async ({ filePath, methodName }: any) => {
        if (getCurrentTokens && maxTokens != null && getCurrentTokens() > maxTokens) {
          return `[SYSTEM WARNING]: Token 消耗已达上限，禁止获取详细方法体。请利用已获取的 Skeleton 信息进行分析。`;
        }
        return engine.getMethodImplementation(filePath, methodName);
      },
    },
    {
      type: "function",
      function: {
        name: "read_full_code",
        description: "读取指定文件的完整源代码内容。当需要分析具体实现逻辑或查找硬编码字符串时使用。",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string", description: "文件相对路径" } },
          required: ["filePath"],
        },
      },
      _handler: async ({ filePath }: any) => {
        if (getCurrentTokens && maxTokens != null && getCurrentTokens() > maxTokens) {
          return `[SYSTEM WARNING]: 当前上下文已达到 ${getCurrentTokens()} tokens (上限 ${maxTokens})。为了保证系统稳定，已拦截 read_full_code。请立即根据已知信息进行总结或停止阅读更多代码。`;
        }
        try {
          if (typeof filePath !== "string" || !filePath) {
            return "Error: filePath 不能为空";
          }
          const fullPath = path.resolve(rootDir(), filePath);
          if (!fullPath.startsWith(rootDir())) {
            return "Error: 权限拒绝，禁止访问项目目录外的文件。";
          }
          if (!fs.existsSync(fullPath)) {
            return `Error: 文件不存在: ${filePath}`;
          }
          const content = fs.readFileSync(fullPath, "utf-8");
          return content
            .split("\n")
            .map((line, i) => `${i + 1} | ${line}`)
            .join("\n");
        } catch (err: any) {
          return `Error: 读取文件失败: ${err.message}`;
        }
      },
    },
  ];
}
