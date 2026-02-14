import fs from 'fs/promises';
import * as minimatchLib from 'minimatch';
const minimatch = typeof minimatchLib === 'function' ? minimatchLib : minimatchLib.minimatch;

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
  depth: z.number().optional().default(2).describe('Recursive depth, default 2 layers. Increasing depth will consume more tokens'),
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
  path: z.string().describe('The starting directory path to search'),
  query: z.string().describe('The text keyword to search'),
  includePattern: z.string().optional().default('**/*').describe('The matching pattern, for example "**/*.ts"'),
  maxFiles: z.number().optional().default(100).describe('The maximum number of files to scan, to prevent large projects from timing out'),
});


const PatchEditArgsSchema = z.object({
  path: z.string().describe('The file path'),
  patches: z.array(z.object({
    startLine: z.number().describe('The start line number (inclusive)'),
    endLine: z.number().describe('The end line number (inclusive)'),
    replacement: z.string().describe('The new code content to insert'),
    originalSnippet: z.string().optional().describe('Optional: The original code snippet within the line range, used to verify and prevent line number offset'),
  })).describe('The patch list. Note: If there are multiple patches, it is recommended to execute from the end of the file to the beginning, or ensure that the line numbers do not overlap'),
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
      'Read the full content of the file. If it exceeds 100 lines, it is forbidden to use, must use read_file_range. Supports head/tail parameters.',
    parameters: ReadTextFileArgsSchema,
    handler: readTextFileHandler,
  });

  const readMultipleFilesTool = createTool({
    name: 'read_multiple_files',
    description:
      'Read the content of multiple files at the same time. Use when you need to compare multiple files or analyze cross-file relationships.' +
      'Note: To prevent token overflow, this tool can read up to 10 files at a time, and each file only displays the first 6000 characters.' +
      'If you need to view the complete large file or specific logic, please use read_file_range instead.',
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
              return `${filePath} (Content truncated):\n${content.substring(0, MAX_CHARS_PER_FILE)}\n\n[... Content too long, only showing the first ${MAX_CHARS_PER_FILE} characters. If you need to view the subsequent content, please use read_file_range to specify the line number to read ...]`;
            }

            return `${filePath}:\n${content}\n`;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return `${filePath}: Read failed - ${errorMessage}`;
          }
        })
      );

      let text = results.join('\n---\n');

      if (isTruncatedByCount) {
        text += `\n\n⚠️ Note: The maximum number of files processed in one request is ${MAX_FILES}. ${args.paths.length - MAX_FILES} files remain unread, please request in batches.`;
      }

      return text;
    },
  });

  const writeFileTool = createTool({
    name: 'write_file',
    description:
      'Only used to create new files. It is forbidden to use it to modify existing source code.',
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
      'Recursively create a directory. Supports nested directories. If the directory already exists, it will be successful silently. Only allowed directories.',
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
      'List the contents of the directory. Return entries with [FILE]/[DIR] prefix, size, and summary. Supports sorting by name or size.',
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
      'Get the recursive tree JSON structure of the directory.' +
      'Default only shows 2 layers of depth to save tokens. If you need to see deeper levels, please increase the depth parameter.',
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
      'Move or rename a file/directory. If the target path already exists, it will fail. The source and target must be within the allowed directories.',
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
      'Search for file names matching a pattern in the specified path. Return a list of matching relative paths.',
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
    description: 'View file metadata (size, line count, modification time). Must call this tool before reading large files.',
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
      'Search for keywords in the content of files in the specified directory.' +
      'This tool will return the file paths and preview of matching lines containing the keywords.' +
      'Please narrow down the search scope as much as possible using includePattern.',
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
        ? `The location of the keyword "${args.query}" is as follows:\n${matches.join('\n')}`
        : `The content containing "${args.query}" was not found.`;

      if (allFiles.length > args.maxFiles) {
        response += `\n\nNote: The search has reached the limit, only scanned the first ${args.maxFiles} files. If no results are found, please provide a more precise path or includePattern.`;
      }
      return response;
    },
  });

  const readFileRangeTool = createTool({
    name: 'read_file_range',
    description:
      'Precisely read the specified line range (includes line number prefix). Must use this tool before modifying code or locating errors based on error messages.',
    parameters: z.object({
      path: z.string().describe('The file path relative to the target directory'),
      startLine: z.number().describe('The starting line number (starts from 1)'),
      endLine: z.number().describe('The ending line number'),
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
          return `Error: The file only has ${totalLines} lines, the starting line number ${start} is out of range.`;
        }
        if (start > end) {
          return `Error: The starting line number ${start} cannot be greater than the ending line number ${end}.`;
        }

        // 3. 截取并添加行号索引（核心：增强 AI 的位置感）
        const selectedLines = lines.slice(start - 1, end);
        const formattedContent = selectedLines
          .map((line, index) => `${start + index}| ${line}`)
          .join('\n');

        return `[File: ${args.path} | Lines ${start} to ${end} / Total ${totalLines} lines]\n${formattedContent}`;
      } catch (error: any) {
        return `Failed to read the file range: ${error.message}`;
      }
    },
  });


  const editFileTool = createTool({
    name: 'edit_file',
    description:
      'Replace code based on line number range. The only tool for modifying logic. Must call read_file_range to get the latest line number before calling. Supports deletion (empty content) or single line replacement.',
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
            return `Error: The line number range ${patch.startLine}-${patch.endLine} is out of the actual range of the file (1-${lines.length})`;
          }

          // 可选：二次校验（防止 AI 记忆了错误的行号）
          if (patch.originalSnippet) {
            const currentText = lines.slice(patch.startLine - 1, patch.endLine).join('\n');
            // 模糊对比，如果差异太大则报错
            if (!currentText.includes(patch.originalSnippet.trim()) && currentText.trim().length > 0) {
              return `Warning: The content of the ${patch.startLine} line has changed, which does not match your expected code. Please read the file again to get the latest line number.`;
            }
          }

          // 执行替换：splice(开始索引, 删除数量, 替换内容)
          // 索引需要减 1
          lines.splice(patch.startLine - 1, (patch.endLine - patch.startLine) + 1, patch.replacement);
        }

        await fs.writeFile(validPath, lines.join('\n'), 'utf-8');
        return `Successfully updated ${args.path} with ${args.patches.length} code changes.`;
      } catch (error: any) {
        return `Patch failed: ${error.message}`;
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
