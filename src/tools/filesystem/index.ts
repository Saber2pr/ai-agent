import fs from 'fs/promises';
import { minimatch } from 'minimatch';
import path from 'path';
import { z } from 'zod';

import { createTool } from '../../utils/createTool';
import {
  applyFileEdits, formatSize, getFileStats, headFile, readFileContent, searchFilesWithValidation,
  setAllowedDirectories, tailFile, validatePath, writeFileContent
} from './lib';

// Schema definitions
const ReadTextFileArgsSchema = z.object({
  path: z.string(),
  tail: z.number().nullable().describe('If provided, returns only the last N lines of the file'),
  head: z.number().nullable().describe('If provided, returns only the first N lines of the file')
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1, "At least one file path must be provided")
    .describe("Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories."),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().nullable().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z.enum(['name', 'size']).nullable().default('name').describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  excludePatterns: z.array(z.string()).nullable().default([])
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).nullable().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

export const getFilesystemTools = (targetDir: string) => {
  setAllowedDirectories([targetDir]);

  // read_file (deprecated) and read_text_file
  const readTextFileHandler = async (args: z.infer<typeof ReadTextFileArgsSchema>) => {
    const validPath = await validatePath(targetDir, args.path);

    if (args.head && args.tail) {
      throw new Error("Cannot specify both head and tail parameters simultaneously");
    }

    let content: string;
    if (args.tail) {
      content = await tailFile(validPath, args.tail);
    } else if (args.head) {
      content = await headFile(validPath, args.head);
    } else {
      content = await readFileContent(validPath);
    }

    return content
  };

  const readTextFileTool = createTool({
    name: "read_text_file",
    description: "Read the complete contents of a file from the file system as text. " +
      "Handles various text encodings and provides detailed error messages " +
      "if the file cannot be read. Use this tool when you need to examine " +
      "the contents of a single file. Use the 'head' parameter to read only " +
      "the first N lines of a file, or the 'tail' parameter to read only " +
      "the last N lines of a file. Operates on the file as text regardless of extension.",
    parameters: ReadTextFileArgsSchema,
    handler: readTextFileHandler
  })

  const readMultipleFilesTool = createTool({
    name: "read_multiple_files",
    description: "Read the contents of multiple files simultaneously. This is more " +
      "efficient than reading files one by one when you need to analyze " +
      "or compare multiple files. Each file's content is returned with its " +
      "path as a reference. Failed reads for individual files won't stop " +
      "the entire operation. Only works within allowed directories.",
    parameters: ReadMultipleFilesArgsSchema,
    handler: async (args: z.infer<typeof ReadMultipleFilesArgsSchema>) => {
      const results = await Promise.all(
        args.paths.map(async (filePath: string) => {
          try {
            const validPath = await validatePath(targetDir, filePath);
            const content = await readFileContent(validPath);
            return `${filePath}:\n${content}\n`;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return `${filePath}: Error - ${errorMessage}`;
          }
        }),
      );
      const text = results.join("\n---\n");
      return text
    }
  })

  const writeFileTool = createTool({
    name: "write_file",
    description: "Create a new file or completely overwrite an existing file with new content. " +
      "Use with caution as it will overwrite existing files without warning. " +
      "Handles text content with proper encoding. Only works within allowed directories.",
    parameters: WriteFileArgsSchema,
    handler: async (args: z.infer<typeof WriteFileArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      await writeFileContent(validPath, args.content);
      const text = `Successfully wrote to ${args.path}`;
      return text
    }
  })

  const editFileTool = createTool({
    name: "edit_file",
    description: "Make line-based edits to a text file. Each edit replaces exact line sequences " +
      "with new content. Returns a git-style diff showing the changes made. " +
      "Only works within allowed directories.",
    parameters: EditFileArgsSchema,
    handler: async (args: z.infer<typeof EditFileArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      const result = await applyFileEdits(validPath, args.edits as any, args.dryRun);
      return result
    }
  })

  const createDirectoryTool = createTool({
    name: "create_directory",
    description: "Create a new directory or ensure a directory exists. Can create multiple " +
      "nested directories in one operation. If the directory already exists, " +
      "this operation will succeed silently. Perfect for setting up directory " +
      "structures for projects or ensuring required paths exist. Only works within allowed directories.",
    parameters: CreateDirectoryArgsSchema,
    handler: async (args) => {
      const validPath = await validatePath(targetDir, args.path);
      await fs.mkdir(validPath, { recursive: true });
      const text = `Successfully created directory ${args.path}`;
      return text
    }
  })

  const listDirectoryTool = createTool({
    name: "list_directory",
    description: "Get a detailed listing of all files and directories in a specified path. " +
      "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
      "prefixes. This tool is essential for understanding directory structure and " +
      "finding specific files within a directory. Only works within allowed directories.",
    parameters: ListDirectoryArgsSchema,
    handler: async (args) => {
      const validPath = await validatePath(targetDir, args.path);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const formatted = entries
        .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
        .join("\n");
      return formatted
    }
  })

  const listDirectoryWithSizesTool = createTool({
    name: "list_directory_with_sizes",
    description: "Get a detailed listing of all files and directories in a specified path, including sizes. " +
      "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
      "prefixes. This tool is useful for understanding directory structure and " +
      "finding specific files within a directory. Only works within allowed directories.",
    parameters: ListDirectoryWithSizesArgsSchema,
    handler: async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      const entries = await fs.readdir(validPath, { withFileTypes: true });

      // Get detailed information for each entry
      const detailedEntries = await Promise.all(
        entries.map(async (entry) => {
          const entryPath = path.join(validPath, entry.name);
          try {
            const stats = await fs.stat(entryPath);
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              mtime: stats.mtime
            };
          } catch (error) {
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: 0,
              mtime: new Date(0)
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
      const formattedEntries = sortedEntries.map(entry =>
        `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
        }`
      );

      // Add summary
      const totalFiles = detailedEntries.filter(e => !e.isDirectory).length;
      const totalDirs = detailedEntries.filter(e => e.isDirectory).length;
      const totalSize = detailedEntries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);

      const summary = [
        "",
        `Total: ${totalFiles} files, ${totalDirs} directories`,
        `Combined size: ${formatSize(totalSize)}`
      ];

      const text = [...formattedEntries, ...summary].join("\n");
      return text
    }
  })

  const directoryTreeTool = createTool({
    name: "directory_tree",
    description: "Get a recursive tree view of files and directories as a JSON structure. " +
      "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
      "Files have no children array, while directories always have a children array (which may be empty). " +
      "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
    parameters: DirectoryTreeArgsSchema,
    handler: async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
      interface TreeEntry {
        name: string;
        type: 'file' | 'directory';
        children?: TreeEntry[];
      }
      const rootPath = args.path;

      async function buildTree(currentPath: string, excludePatterns: string[] = []): Promise<TreeEntry[]> {
        const validPath = await validatePath(targetDir, currentPath);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const result: TreeEntry[] = [];

        for (const entry of entries) {
          const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
          const shouldExclude = excludePatterns.some(pattern => {
            if (pattern.includes('*')) {
              return minimatch(relativePath, pattern, { dot: true });
            }
            // For files: match exact name or as part of path
            // For directories: match as directory path
            return minimatch(relativePath, pattern, { dot: true }) ||
              minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
              minimatch(relativePath, `**/${pattern}/**`, { dot: true });
          });
          if (shouldExclude)
            continue;

          const entryData: TreeEntry = {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file'
          };

          if (entry.isDirectory()) {
            const subPath = path.join(currentPath, entry.name);
            entryData.children = await buildTree(subPath, excludePatterns);
          }

          result.push(entryData);
        }

        return result;
      }

      const treeData = await buildTree(rootPath, args.excludePatterns);
      const text = JSON.stringify(treeData, null, 2);
      return text
    }
  })

  const moveFileTool = createTool({
    name: "move_file",
    description: "Move or rename files and directories. Can move files between directories " +
      "and rename them in a single operation. If the destination exists, the " +
      "operation will fail. Works across different directories and can be used " +
      "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
    parameters: MoveFileArgsSchema,
    handler: async (args: z.infer<typeof MoveFileArgsSchema>) => {
      const validSourcePath = await validatePath(targetDir, args.source);
      const validDestPath = await validatePath(targetDir, args.destination);
      await fs.rename(validSourcePath, validDestPath);
      const text = `Successfully moved ${args.source} to ${args.destination}`;
      return text
    }
  })

  const searchFilesTool = createTool({
    name: "search_files",
    description: "Search for files matching a specific pattern in a specified path. " +
      "Returns a list of files that match the pattern. Only works within allowed directories.",
    parameters: SearchFilesArgsSchema,
    handler: async (args: z.infer<typeof SearchFilesArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      const results = await searchFilesWithValidation(targetDir, validPath, args.pattern, [], { excludePatterns: args.excludePatterns });
      const text = results.length > 0 ? results.join("\n") : "No matches found";
      return text
    }
  })

  const getFileInfoTool = createTool({
    name: "get_file_info",
    description: "Get detailed information about a file, including its size, last modified time, and type. " +
      "Only works within allowed directories.",
    parameters: GetFileInfoArgsSchema,
    handler: async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
      const validPath = await validatePath(targetDir, args.path);
      const info = await getFileStats(validPath);
      const text = Object.entries(info)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      return text
    }
  })

  return [
    readTextFileTool,
    readMultipleFilesTool,
    writeFileTool,
    editFileTool,
    createDirectoryTool,
    listDirectoryTool,
    listDirectoryWithSizesTool,
    directoryTreeTool,
    moveFileTool,
    searchFilesTool,
    getFileInfoTool,
  ];
}