/**
 * Transform multi-line output into single-line format with line markers.
 * Empty lines in the middle are preserved with their line numbers (e.g., "[3] ").
 */
export function transformOutput(output: string): string {
  const lines = output.split('\n');

  // Remove trailing empty line caused by trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // Handle empty output
  if (lines.length === 0) {
    return '';
  }

  return lines.map((line, i) => `[${i + 1}] ${line}`).join(' ');
}
