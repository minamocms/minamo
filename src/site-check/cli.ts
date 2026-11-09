#!/usr/bin/env node
import { resolve } from 'node:path';
import { runSiteCheck } from './run-check.ts';
import type { CheckFinding, CheckFindingKind } from './run-check.ts';
import { out } from '../terminal/ui.ts';

const ui = out();

// Run from vhost/ (see the scaffold's own "check" script), so the
// site root is one level up - the exact same relative relationship
// SERVER_JS in create-site/generate-site.ts already relies on.
const siteRoot = resolve(process.cwd(), '..');

const KIND_LABELS: Record<CheckFindingKind, string> = {
  schema: 'Theme schema',
  'render-error': 'Render error',
  'missing-asset': 'Missing asset',
  'broken-link': 'Broken link',
  'misplaced-media': 'Misplaced media',
};

function printGrouped(findings: CheckFinding[]): void {
  const byKind = new Map<CheckFindingKind, CheckFinding[]>();
  for (const finding of findings) {
    const list = byKind.get(finding.kind) ?? [];
    list.push(finding);
    byKind.set(finding.kind, list);
  }
  for (const [kind, list] of byKind) {
    ui.blank();
    ui.heading(`${KIND_LABELS[kind]} (${list.length}):`);
    for (const finding of list) {
      const where = finding.pageUrl ? `${ui.fancy ? ui.style(finding.pageUrl, 'cyan') : finding.pageUrl}: ` : '';
      ui.line(`  ${ui.fancy ? `${ui.style('✖', 'red')} ` : ''}${where}${finding.message}`);
    }
  }
}

function printSuggestions(suggestions: string[]): void {
  if (suggestions.length === 0) {
    return;
  }
  ui.blank();
  ui.heading(`Suggestions (${suggestions.length}):`);
  for (const suggestion of suggestions) {
    ui.line(`  ${ui.fancy ? `${ui.style('•', 'cyan')} ` : ''}${suggestion}`);
  }
}

ui.header('minamo check');
const checking = ui.spinner('Rendering every published page');
const result = await runSiteCheck(siteRoot).finally(() => checking.stop());

if (result.ok) {
  ui.success('No problems found.');
  printSuggestions(result.suggestions);
  process.exit(0);
}

ui.error(`${result.findings.length} problem${result.findings.length === 1 ? '' : 's'} found:`);
printGrouped(result.findings);
printSuggestions(result.suggestions);
process.exit(1);
