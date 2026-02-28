import { AgentOptions, ToolInfo } from "../types/type";
import { getFilesystemTools } from "./filesystem";
import { getTsLspTools } from "./ts-lsp";
import { getAllToolsSchema } from "./loader/get_all_tools_schema";
import { batchRunTools } from "./loader/batch_run_tools";

export interface BuiltinToolsContext {
  options?: AgentOptions;
}

export function createDefaultBuiltinTools(
  context: BuiltinToolsContext,
): ToolInfo[] {
  const { options } = context;

  return [
    ...getTsLspTools(options?.targetDir || process.cwd()),
    ...getFilesystemTools(options?.targetDir || process.cwd()),
    getAllToolsSchema,
    batchRunTools,
  ];
}
