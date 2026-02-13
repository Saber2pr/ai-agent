import { z } from 'zod';

import { PromptEngine } from '@saber2pr/ts-context-mcp';

import { createTool } from '../../utils/createTool';

export const getTsLspTools = (targetDir: string) => {
  const engine = new PromptEngine(targetDir);
  return [
    createTool({
      name: 'get_method_body',
      description:
        '【仅限TS/JS】通过方法名提取代码块。比行号读取更抗干扰，参考逻辑时首选。',
      parameters: z.object({
        filePath: z.string().describe('文件相对路径'),
        methodName: z.string().describe('方法名或函数名'),
      }),
      handler: async ({ filePath, methodName }) => {
        return engine.getMethodImplementation(filePath, methodName);
      },
    }),
    createTool({
      name: 'get_repo_map',
      description: '获取项目全局文件结构及导出清单，用于快速定位代码',
      parameters: z.object({}),
      handler: async () => {
        engine.refresh();
        return engine.getRepoMap();
      },
    }),
    createTool({
      name: 'analyze_deps',
      description: '分析指定文件的依赖关系，支持 tsconfig 路径别名解析',
      parameters: z.object({ filePath: z.string().describe('文件相对路径') }),
      handler: async ({ filePath }) => engine.getDeps(filePath),
    }),
    createTool({
      name: 'read_skeleton',
      description: '提取文件的结构定义（接口、类、方法签名），忽略具体实现以节省 Token',
      parameters: z.object({ filePath: z.string().describe('文件相对路径') }),
      handler: async args => {
        const pathArg = args?.filePath;
        if (typeof pathArg !== 'string' || pathArg.trim() === '') {
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
    }),
  ];
};
