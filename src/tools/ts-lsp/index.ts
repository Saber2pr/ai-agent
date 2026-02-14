import { z } from 'zod';

import { PromptEngine } from '@saber2pr/ts-context-mcp';

import { createTool } from '../../utils/createTool';

export const getTsLspTools = (targetDir: string) => {
  const engine = new PromptEngine(targetDir);
  return [
    createTool({
      name: 'get_method_body',
      description:
        '[Only for TS/JS] Extract code blocks by method name. More resistant to interference than line number reading, preferred when referencing logic.',
      parameters: z.object({
        filePath: z.string().describe('The relative file path'),
        methodName: z.string().describe('The method name or function name'),
      }),
      handler: async ({ filePath, methodName }) => {
        const res = engine.getMethodImplementation(filePath, methodName);
        return typeof res === 'string' ? res : JSON.stringify(res);
      },
    }),
    createTool({
      name: 'get_repo_map',
      description: 'Get the global file structure and export list of the project, used for quick code location',
      parameters: z.object({}),
      handler: async () => {
        engine.refresh();
        return engine.getRepoMap();
      },
    }),
    createTool({
      name: 'analyze_deps',
      description: 'Analyze the dependencies of the specified file, support tsconfig path alias parsing',
      parameters: z.object({ filePath: z.string().describe('The relative file path') }),
      handler: async ({ filePath }) => engine.getDeps(filePath),
    }),
    createTool({
      name: 'read_skeleton',
      description: 'Extract the structure definition of the file (interface, class, method signature), ignoring the specific implementation to save tokens',
      parameters: z.object({ filePath: z.string().describe('The relative file path') }),
      handler: async args => {
        const pathArg = args?.filePath;
        if (typeof pathArg !== 'string' || pathArg.trim() === '') {
          return `Error: The parameter 'filePath' is invalid. Received: ${JSON.stringify(pathArg)}`;
        }
        try {
          engine.refresh();
          const result = engine.getSkeleton(pathArg);
          return result || `// Warning: The file ${pathArg} exists but no structure can be extracted.`;
        } catch (error: any) {
          return `Error: An internal error occurred while parsing the file ${pathArg}: ${error.message}`;
        }
      },
    }),
  ];
};
