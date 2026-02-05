import { AgentOptions, ToolInfo } from '../types/type';
import { getFilesystemTools } from './filesystem';
import { getTsLspTools } from './ts-lsp';

export interface BuiltinToolsContext {
  options?: AgentOptions;
}

export function createDefaultBuiltinTools(context: BuiltinToolsContext): ToolInfo[] {
  const { options } = context;

  return [
    ...getTsLspTools(options?.targetDir || process.cwd()),
    ...getFilesystemTools(options?.targetDir || process.cwd()),
  ];
}
