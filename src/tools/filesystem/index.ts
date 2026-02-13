import fs from 'fs/promises';
import { minimatch } from 'minimatch';
import path from 'path';
import { z } from 'zod';

import { createTool } from '../../utils/createTool';
import {
  formatSize,
  getFileStats,
  headFile,
  isBinaryOrIrrelevant,
  readFileContent,
  searchFilesWithValidation,
  setAllowedDirectories,
  tailFile,
  validatePath,
  writeFileContent,
} from './lib';

const DEFAULT_IGNORE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '.next/**',
  'out/**',
  '*.log',
  '.DS_Store'
];

// Schema definitions
const ReadTextFileArgsSchema = z.object({
  path: z.string(),
  tail: z.number().optional().describe('If provided, returns only the last N lines of the file'),
  head: z.number().optional().describe('If provided, returns only the first N lines of the file'),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1, 'At least one file path must be provided')
    .describe(
      'Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories.'
    ),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z
    .enum(['name', 'size'])
    .optional()
    .default('name')
    .describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
  depth: z.number().optional().default(2).describe('递归深度，默认 2 层。增加深度会消耗更多 Token'),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const GrepSearchArgsSchema = z.object({
  path: z.string().describe('搜索的起始目录路径'),
  query: z.string().describe('要搜索的文本关键字'),
  includePattern: z.string().optional().default('**/*').describe('匹配模式，例如 "**/*.ts"'),
  maxFiles: z.number().optional().default(100).describe('最大扫描文件数，防止大型项目超时'),
});


const PatchEditArgsSchema = z.object({
  path: z.string().describe('文件路径'),
  patches: z.array(z.object({
    startLine: z.number().describe('起始行号（包含）'),
    endLine: z.number().describe('结束行号（包含）'),
    replacement: z.string().describe('要插入的新代码内容'),
    originalSnippet: z.string().optional().describe('可选：该行范围内的原始代码片段，用于二次校验防止行号偏移'),
  })).describe('补丁列表。注意：若有多个补丁，建议从文件尾部向头部执行，或确保行号不重叠'),
});

export const getFilesystemTools = (targetDir: string) => {
  setAllowedDirectories([targetDir]);

  // read_file (deprecated) and read_text_file
  const readTextFileHandler = async (args: z.infer<typeof ReadTextFileArgsSchema>) => {
    const validPath = await validatePath(targetDir, args.path);

    if (args.head && args.tail) {
      throw new Error('Cannot specify both head and tail parameters simultaneously');
    }

    let content: string;
    if (args.tail) {
      content = await tailFile(validPath, args.tail);
    } else if (args.head) {
      content = await headFile(validPath, args.head);
    } else {
      content = await readFileContent(validPath);
    }

    return content;
  };

  const readTextFileTool = createTool({
    name: 'read_text_file',
    description:
      '读取文件全文。若超过100行则禁止使用，必须改用 read_file_range。支持 head/tail 参数。',
    parameters: ReadTextFileArgsSchema,
    handler: readTextFileHandler,
  });

  const readMultipleFilesTool = createTool({
    name: 'read_multiple_files',
    description:
      '同时读取多个文件的内容。当你需要对比多个文件或分析跨文件关联时使用。' +
      '注意：为了防止 Token 溢出，本工具一次最多读取 10 个文件，且每个文件仅展示前 6000 字符。' +
      '若需查看完整大文件或特定逻辑，请改用 read_file_range。',
    parameters: ReadMultipleFilesArgsSchema,
    handler: async (args: z.infer<typeof ReadMultipleFilesArgsSchema>) => {
      // 保护 1：文件数量限制 (防止 AI 一次传入几十个文件)
      const MAX_FILES = 10;
      const pathsToRead = args.paths.slice(0, MAX_FILES);
      const isTruncatedByCount = args.paths.length > MAX_FILES;

      // 保护 2：单文件字符数限制 (防止读入超大型二进制或日志文件)
      const MAX_CHARS_PER_FILE = 6000;

      const results = await Promise.all(
        pathsToRead.map(async (filePath: string) => {
          try {
            // 沿用你现有的路径验证逻辑
            const validPath = await validatePath(targetDir, filePath);
            const content = await readFileContent(validPath);

            if (content.length > MAX_CHARS_PER_FILE) {
              return `${filePath} (内容已截断):\n${content.substring(0, MAX_CHARS_PER_FILE)}\n\n[... 内容过长，仅展示前 ${MAX_CHARS_PER_FILE} 字符。若需查看后续内容，请使用 read_file_range 指定行号读取 ...]`;
            }

            return `${filePath}:\n${content}\n`;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return `${filePath}: 读取失败 - ${errorMessage}`;
          }
        })
      );

      let text = results.join('\n---\n');

      if (isTruncatedByCount) {
        text += `\n\n⚠️ 注意：一次请求最多处理 ${MAX_FILES} 个文件。剩余 ${args.paths.length - MAX_FILES} 个文件未读取，请分批请求。`;
      }

      return text;
    },
  });

  const writeFileTool = createTool({
    name: 'write_file',
    description:
      '仅用于创建新文件。严禁用于修改现有源代码。',
    parameters: WriteFileArgsSchema,
    handler: async (args: z.infer<typeof WriteFileArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      await writeFileContent(validPath, args.content);
      const text = `Successfully wrote to ${args.path}`;
      return text;
    },
  });

  const createDirectoryTool = createTool({
    name: 'create_directory',
    description:
      'Create a new directory or ensure a directory exists. Can create multiple ' +
      'nested directories in one operation. If the directory already exists, ' +
      'this operation will succeed silently. Perfect for setting up directory ' +
      'structures for projects or ensuring required paths exist. Only works within allowed directories.',
    parameters: CreateDirectoryArgsSchema,
    handler: async args => {
      const validPath = await validatePath(targetDir, args.path);
      await fs.mkdir(validPath, { recursive: true });
      const text = `Successfully created directory ${args.path}`;
      return text;
    },
  });

  const listDirectoryWithSizesTool = createTool({
    name: 'list_directory',
    description:
      'Get a detailed listing of all files and directories in a specified path, including sizes. ' +
      'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
      'prefixes. This tool is useful for understanding directory structure and ' +
      'finding specific files within a directory. Only works within allowed directories.',
    parameters: ListDirectoryWithSizesArgsSchema,
    handler: async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      const entries = await fs.readdir(validPath, { withFileTypes: true });

      // Get detailed information for each entry
      const detailedEntries = await Promise.all(
        entries.map(async entry => {
          const entryPath = path.join(validPath, entry.name);
          try {
            const stats = await fs.stat(entryPath);
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              mtime: stats.mtime,
            };
          } catch (error) {
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: 0,
              mtime: new Date(0),
            };
          }
        })
      );

      // Sort entries based on sortBy parameter
      const sortedEntries = [...detailedEntries].sort((a, b) => {
        if (args.sortBy === 'size') {
          return b.size - a.size; // Descending by size
        }
        // Default sort by name
        return a.name.localeCompare(b.name);
      });

      // Format the output
      const formattedEntries = sortedEntries.map(
        entry =>
          `${entry.isDirectory ? '[DIR]' : '[FILE]'} ${entry.name.padEnd(30)} ${entry.isDirectory ? '' : formatSize(entry.size).padStart(10)
          }`
      );

      // Add summary
      const totalFiles = detailedEntries.filter(e => !e.isDirectory).length;
      const totalDirs = detailedEntries.filter(e => e.isDirectory).length;
      const totalSize = detailedEntries.reduce(
        (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
        0
      );

      const summary = [
        '',
        `Total: ${totalFiles} files, ${totalDirs} directories`,
        `Combined size: ${formatSize(totalSize)}`,
      ];

      const text = [...formattedEntries, ...summary].join('\n');
      return text;
    },
  });

  const directoryTreeTool = createTool({
    name: 'directory_tree',
    description:
      '获取目录的递归树状 JSON 结构。' +
      '默认仅展示 2 层深度以节省 Token。如果需要看更深层级，请调大 depth 参数。',
    parameters: DirectoryTreeArgsSchema,
    handler: async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
      // 在 directory_tree 的 handler 内部
      const combinedExcludes = [...DEFAULT_IGNORE, ...(args.excludePatterns || [])];
      // 在循环中使用 combinedExcludes 过滤

      interface TreeEntry {
        name: string;
        type: 'file' | 'directory';
        children?: TreeEntry[];
      }
      const rootPath = args.path;

      async function buildTree(
        currentPath: string,
        currentDepth: number,
        maxDepth: number,
        excludePatterns: string[] = []
      ): Promise<TreeEntry[]> {
        if (currentDepth > maxDepth) return []; // 深度限制

        const validPath = await validatePath(targetDir, currentPath);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const result: TreeEntry[] = [];

        for (const entry of entries) {
          const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
          const shouldExclude = excludePatterns.some(pattern => minimatch(relativePath, pattern, { dot: true }));
          if (shouldExclude) continue;

          const entryData: TreeEntry = {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
          };

          if (entry.isDirectory() && currentDepth < maxDepth) {
            const subPath = path.join(currentPath, entry.name);
            entryData.children = await buildTree(subPath, currentDepth + 1, maxDepth, excludePatterns);
          }

          result.push(entryData);
        }
        return result;
      }

      const treeData = await buildTree(rootPath, 1, args.depth, combinedExcludes);
      return JSON.stringify(treeData, null, 2);
    },
  });

  const moveFileTool = createTool({
    name: 'move_file',
    description:
      'Move or rename files and directories. Can move files between directories ' +
      'and rename them in a single operation. If the destination exists, the ' +
      'operation will fail. Works across different directories and can be used ' +
      'for simple renaming within the same directory. Both source and destination must be within allowed directories.',
    parameters: MoveFileArgsSchema,
    handler: async (args: z.infer<typeof MoveFileArgsSchema>) => {
      const validSourcePath = await validatePath(targetDir, args.source);
      const validDestPath = await validatePath(targetDir, args.destination);
      await fs.rename(validSourcePath, validDestPath);
      const text = `Successfully moved ${args.source} to ${args.destination}`;
      return text;
    },
  });

  const searchFilesTool = createTool({
    name: 'search_files',
    description:
      'Search for files matching a specific pattern in a specified path. ' +
      'Returns a list of files that match the pattern. Only works within allowed directories.' +
      'Used only for filename search',
    parameters: SearchFilesArgsSchema,
    handler: async (args: z.infer<typeof SearchFilesArgsSchema>) => {
      const combinedExcludes = [...DEFAULT_IGNORE, ...(args.excludePatterns || [])];
      const validPath = await validatePath(targetDir, args.path);
      const results = await searchFilesWithValidation(targetDir, validPath, args.pattern, [targetDir], {
        excludePatterns: combinedExcludes,
      });
      const text = results.length > 0 ? results.join('\n') : 'No matches found';
      return text;
    },
  });

  const getFileInfoTool = createTool({
    name: 'get_file_info',
    description: '查看文件元数据（大小、行数、修改时间）。读取大文件前务必先调用此工具。',
    parameters: GetFileInfoArgsSchema,
    handler: async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      const stats = await fs.stat(validPath);

      // 计算行数：读取内容并按换行符分割
      // 注意：对于极大的文件，这种方式可能稍慢，但对普通源代码文件非常有效
      const content = await fs.readFile(validPath, 'utf-8');
      const lineCount = content.split('\n').length;

      const info = {
        size: `${(stats.size / 1024).toFixed(2)} KB`,
        lineCount: lineCount, // 新增行号字段
        mtime: stats.mtime.toLocaleString(),
        type: path.extname(validPath) || 'unknown'
      };

      return Object.entries(info)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    },
  });

  const grepSearchTool = createTool({
    name: 'grep_search',
    description:
      '在指定目录的文件内容中搜索关键字。' +
      '该工具会返回包含关键字的文件路径及匹配行的预览。' +
      '请尽量通过 includePattern 缩小搜索范围。',
    parameters: GrepSearchArgsSchema,
    handler: async (args: z.infer<typeof GrepSearchArgsSchema>) => {
      const startPath = await validatePath(targetDir, args.path);
      const allFiles = await searchFilesWithValidation(
        targetDir,
        startPath,
        args.includePattern,
        [targetDir],
        { excludePatterns: ['node_modules', 'dist', '.git', 'build'] }
      );

      // 限制扫描文件数，防止爆炸
      const filesToScan = allFiles.slice(0, args.maxFiles);
      const matches: string[] = [];
      const concurrencyLimit = 10;

      for (let i = 0; i < filesToScan.length; i += concurrencyLimit) {
        const chunk = filesToScan.slice(i, i + concurrencyLimit);
        await Promise.all(
          chunk.map(async (filePath) => {
            try {
              const stats = await fs.stat(filePath);
              if (!stats.isFile()) return;
              // 在 grep_search 扫描文件时增加判断
              if (isBinaryOrIrrelevant(path.extname(filePath))) return;

              const content = await readFileContent(filePath);
              if (content.includes(args.query)) {
                const relativePath = path.relative(targetDir, filePath);
                // 找到匹配的那一行（预览用）
                const lines = content.split('\n');
                const matchLineIndex = lines.findIndex(l => l.includes(args.query));
                matches.push(`${relativePath} (Line ${matchLineIndex + 1}: "${lines[matchLineIndex].trim().substring(0, 100)}")`);
              }
            } catch { /* 忽略错误文件 */ }
          })
        );
      }

      let response = matches.length > 0
        ? `找到关键词 "${args.query}" 的位置如下：\n${matches.join('\n')}`
        : `未找到包含 "${args.query}" 的内容。`;

      if (allFiles.length > args.maxFiles) {
        response += `\n\n注意：搜索已达到限制，仅扫描了前 ${args.maxFiles} 个文件。若未找到结果，请提供更精确的 path 或 includePattern。`;
      }
      return response;
    },
  });

  const readFileRangeTool = createTool({
    name: 'read_file_range',
    description:
      '精准读取指定行范围（包含行号前缀）。修改代码前或根据报错定位时必用。',
    parameters: z.object({
      path: z.string().describe('相对于目标目录的文件路径'),
      startLine: z.number().describe('起始行号（从 1 开始计）'),
      endLine: z.number().describe('结束行号'),
    }),
    handler: async (args) => {
      // 1. 验证路径安全（沿用你代码中的 validatePath 逻辑）
      const validPath = await validatePath(targetDir, args.path);

      try {
        const content = await fs.readFile(validPath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        // 2. 边界保护：确保行号不越界
        const start = Math.max(1, args.startLine);
        const end = Math.min(totalLines, args.endLine);

        if (start > totalLines) {
          return `错误：文件仅有 ${totalLines} 行，起始行号 ${start} 超出范围。`;
        }
        if (start > end) {
          return `错误：起始行号 ${start} 不能大于结束行号 ${end}。`;
        }

        // 3. 截取并添加行号索引（核心：增强 AI 的位置感）
        const selectedLines = lines.slice(start - 1, end);
        const formattedContent = selectedLines
          .map((line, index) => `${start + index}| ${line}`)
          .join('\n');

        return `[文件: ${args.path} | 第 ${start} 至 ${end} 行 / 共 ${totalLines} 行]\n${formattedContent}`;
      } catch (error: any) {
        return `读取文件范围失败: ${error.message}`;
      }
    },
  });


  const editFileTool = createTool({
    name: 'edit_file',
    description:
      '基于行号范围替换代码。修改逻辑的唯一工具。调用前须通过 read_file_range 获取最新行号。支持删除(空内容)或单行替换。',
    parameters: PatchEditArgsSchema,
    handler: async (args: z.infer<typeof PatchEditArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);

      try {
        const content = await fs.readFile(validPath, 'utf-8');
        let lines = content.split('\n');

        // 按起始行号从大到小排序，这样修改前面的行不会影响后面待修改行的索引
        const sortedPatches = [...args.patches].sort((a, b) => b.startLine - a.startLine);

        for (const patch of sortedPatches) {
          // 校验行号合法性
          if (patch.startLine < 1 || patch.endLine > lines.length || patch.startLine > patch.endLine) {
            return `错误：行号范围 ${patch.startLine}-${patch.endLine} 超出文件实际范围 (1-${lines.length})`;
          }

          // 可选：二次校验（防止 AI 记忆了错误的行号）
          if (patch.originalSnippet) {
            const currentText = lines.slice(patch.startLine - 1, patch.endLine).join('\n');
            // 模糊对比，如果差异太大则报错
            if (!currentText.includes(patch.originalSnippet.trim()) && currentText.trim().length > 0) {
              return `警告：第 ${patch.startLine} 行的内容已发生变动，与你预想的代码不符。请重新读取文件获取最新行号。`;
            }
          }

          // 执行替换：splice(开始索引, 删除数量, 替换内容)
          // 索引需要减 1
          lines.splice(patch.startLine - 1, (patch.endLine - patch.startLine) + 1, patch.replacement);
        }

        await fs.writeFile(validPath, lines.join('\n'), 'utf-8');
        return `成功通过行号更新了 ${args.path} 的 ${args.patches.length} 处代码。`;
      } catch (error: any) {
        return `Patch 失败: ${error.message}`;
      }
    },
  });

  return [
    readFileRangeTool,
    editFileTool,
    directoryTreeTool,
    listDirectoryWithSizesTool,
    grepSearchTool,
    getFileInfoTool,
    readTextFileTool,
    readMultipleFilesTool,
    searchFilesTool,
    writeFileTool,
    createDirectoryTool,
    moveFileTool,
  ];
};
