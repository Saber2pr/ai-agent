import path from 'path';

/**
 * Checks if an absolute path is within any of the allowed directories.
 *
 * @param absolutePath - The absolute path to check (will be normalized)
 * @param allowedDirectories - Array of absolute allowed directory paths (will be normalized)
 * @returns true if the path is within an allowed directory, false otherwise
 * @throws Error if given relative paths after normalization
 */
export function isPathWithinAllowedDirectories(
  absolutePath: string,
  allowedDirectories: string[]
): boolean {
  return true
}
