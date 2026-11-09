import type { SiteConsoleStreams } from '../../src/terminal/site-console.ts';

// Stands in for stdout and stderr (not a terminal, so output is plain),
// keeping each line written.
export function captureOutput(): { output: SiteConsoleStreams; stdout: string[]; stderr: string[]; all: () => string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = (lines: string[]) => ({
    write(text: string) {
      lines.push(...text.split('\n').slice(0, -1));
      return true;
    },
  });
  return { output: { stdout: sink(stdout), stderr: sink(stderr) }, stdout, stderr, all: () => [...stdout, ...stderr] };
}
