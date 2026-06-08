#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { Octokit } from '@octokit/core';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.join(__dirname, '../library_docs');
const OCTOKIT_TOKEN = process.env.GITHUB_TOKEN;

// Track statistics
let totalSkipped = 0;
let totalSaved = 0;

/**
 * Files to exclude from documentation fetching with explanations
 * These files are not relevant for ProPR's automated GitHub issue processing
 */
const EXCLUDED_FILES = new Set([
  // === CLAUDE DOCUMENTATION EXCLUSIONS ===

  // Extremely large/low-value files
  'beta.md', // Raw TypeScript API definitions - extremely large file with high token cost
  'llms-full.txt', // Build artifact/raw text dump

  // UI/Batch operation files
  'cancel.md', // Batch operation UI
  'create.md', // File operation UI
  'delete.md', // File operation UI
  'download.md', // File operation UI
  'list.md', // File operation UI
  'retrieve.md', // File operation UI
  'retrieve_metadata.md', // Batch operation UI
  'results.md', // Batch operation UI
  'upload.md', // File operation UI

  // Feature-specific (not applicable to ProPR)
  'claude-for-sheets.md', // Google Sheets add-on
  'completions.md', // Legacy completions API
  'computer-use-tool.md', // Desktop automation tool
  'customer-support-chat.md', // Support agent guidelines

  // Interactive UI features (ProPR is headless/automated)
  'hooks-guide.md', // Interactive user hooks
  'hosting.md', // Hosting Claude apps
  'output-styles.md', // UI formatting
  'plugins.md', // Plugin system (UI-based)
  'sessions.md', // Session management (interactive)
  'slash-commands.md', // Interactive commands
  'subagents.md', // Interactive subagent spawning
  'text-editor-tool.md', // Editor integration
  'todo-tracking.md', // Interactive todo tracking
  'tool-search-tool.md', // Tool discovery UI

  // Wrong language SDK
  'python.md', // Python SDK - ProPR uses TypeScript

  // User-facing support
  'troubleshooting.md', // Installation and IDE plugin issues

  // API Key Required (ProPR uses subscription-based auth)
  'batches.md', // Batch API operations - requires API key
  'bash-tool.md', // Bash tool via API - requires API key
  'code-execution-tool.md', // Code execution via API - requires API key
  'count_tokens.md', // Token counting API - requires API key
  'files.md', // File upload/management API - requires API key
  'fine-grained-tool-streaming.md', // Tool streaming API - requires API key
  'mcp-connector.md', // MCP connector API - requires API key
  'memory-tool.md', // Memory tool API - requires API key
  'messages.md', // Core Messages API - requires API key
  'models.md', // Model information API - requires API key
  'openai-sdk.md', // OpenAI-compatible API access - requires API key
  'overview.md', // API overview with examples - requires API key
  'programmatic-tool-calling.md', // Tool calling API - requires API key
  'versions.md', // API versions - requires API key
  'web-fetch-tool.md', // Web fetch via API - requires API key
  'web-search-tool.md', // Web search via API - requires API key

  // === CODEX DOCUMENTATION EXCLUSIONS ===

  // Legal/Administrative
  'CLA.md', // Contributor License Agreement
  'contributing.md', // Contributing guide
  'license.md', // Repository license
  'open-source-fund.md', // Marketing/funding
  'zdr.md', // Zero Data Retention policy

  // Platform-specific (ProPR uses Linux containers)
  'platform-sandboxing.md', // Platform-specific sandboxing
  'windows_sandbox_security.md', // Windows-specific, agent runs in Linux

  // Installation (ProPR uses Docker)
  'install.md', // Manual installation guide, agent uses Docker

  // Interactive/UI
  'slash_commands.md', // Interactive commands

  // User support
  'faq.md', // General user FAQ

  // Experimental
  'experimental.md', // Experimental features

  // Agent CLI internals
  'architecture.md', // Internal design of CLI tools
  'integration-tests.md', // Internal CLI test docs
  'issue-and-pr-automation.md', // Internal GitHub automation docs
  'local-development.md', // Internal CLI development docs
  'release-confidence.md', // Internal release checklists
  'releases.md', // Internal release process docs
  'CONTRIBUTING.md', // Contributor guide for upstream CLI repos
  'tos-privacy.md', // Legal terms
]);

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

const octokit = new Octokit({ auth: OCTOKIT_TOKEN });

/**
 * Fetch markdown files from a GitHub directory and save them to local destination
 */
async function fetchGithubDocs(owner: string, repo: string, dirPath: string, destDir: string): Promise<void> {
  console.log(`Fetching GitHub docs from ${owner}/${repo}/${dirPath}...`);
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: dirPath,
    });

    if (!Array.isArray(data)) {
      console.warn(`Path ${dirPath} is not a directory`);
      return;
    }

    await fs.ensureDir(destDir);

    for (const item of data) {
      if (item.type === 'file' && item.name.endsWith('.md')) {
        // Check if file is excluded
        if (EXCLUDED_FILES.has(item.name)) {
          console.log(`  Skipped ${item.name} (excluded)`);
          totalSkipped++;
          continue;
        }

        // Fetch raw content
        const contentResponse = await fetch(item.download_url as string);
        const content = await contentResponse.text();
        await fs.writeFile(path.join(destDir, item.name), content);
        console.log(`  Saved ${item.name}`);
        totalSaved++;
      }
    }
  } catch (error) {
    console.error(`Error fetching GitHub docs for ${owner}/${repo}:`, error);
  }
}

/**
 * Fetch a web page and convert its main content to Markdown
 */
async function fetchWebPageToMarkdown(url: string, destDir: string, filename: string): Promise<void> {
  // Check if file is excluded
  if (EXCLUDED_FILES.has(filename)) {
    console.log(`  Skipped ${filename} (excluded)`);
    totalSkipped++;
    return;
  }

  console.log(`  Fetching web page ${url}...`);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`    Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      return;
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    // Remove script, style, and navigation elements
    $('script, style, nav, footer, header, [role="navigation"]').remove();

    // Try specific content selectors in order of preference
    // code.claude.com uses #content-area
    // Other sites may use article, main, or [role="main"]
    let contentHtml = $('#content-area').html();
    if (!contentHtml) {
      contentHtml = $('article').html();
    }
    if (!contentHtml) {
      contentHtml = $('main').html();
    }
    if (!contentHtml) {
      contentHtml = $('[role="main"]').html();
    }
    if (!contentHtml) {
      contentHtml = $('body').html();
    }

    if (contentHtml) {
      const markdown = turndownService.turndown(contentHtml);
      await fs.ensureDir(destDir);
      await fs.writeFile(path.join(destDir, filename), markdown);
      console.log(`    Saved ${filename}`);
      totalSaved++;
    }
  } catch (error) {
    console.error(`  Error fetching ${url}:`, error);
  }
}

/**
 * Sections from llms.txt that we want to include
 */
const RELEVANT_SECTIONS = [
  'general',
  'cli',
  'typescript',
  'sdk',
  'agent',
  'tool',
];

/**
 * Check if a line or section title contains relevant keywords
 */
function isRelevantSection(text: string): boolean {
  const lower = text.toLowerCase();
  return RELEVANT_SECTIONS.some(keyword => lower.includes(keyword));
}

/**
 * Parse llms.txt and extract documentation URLs from relevant sections
 */
function parseLlmsTxt(content: string): { title: string; url: string }[] {
  const links: { title: string; url: string }[] = [];
  const lines = content.split('\n');

  let currentSection = '';
  let inRelevantSection = false;

  for (const line of lines) {
    // Check for section headers (## or ###)
    if (line.startsWith('#')) {
      currentSection = line.replace(/^#+\s*/, '').trim();
      inRelevantSection = isRelevantSection(currentSection);
      continue;
    }

    // Parse markdown links: - [Title](url)
    const linkMatch = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const [, title, url] = linkMatch;

      // Include if in relevant section OR if the title/URL itself is relevant
      if (inRelevantSection || isRelevantSection(title) || isRelevantSection(url)) {
        // Only include .md files or API documentation URLs
        if (url.endsWith('.md') || url.includes('/docs/')) {
          links.push({ title: title.trim(), url: url.trim() });
        }
      }
    }
  }

  return links;
}

/**
 * Fetch a markdown file from a URL and save it
 */
async function fetchMarkdownFile(url: string, destDir: string, filename: string): Promise<void> {
  // Check if file is excluded
  if (EXCLUDED_FILES.has(filename)) {
    console.log(`    Skipped ${filename} (excluded)`);
    totalSkipped++;
    return;
  }

  console.log(`    Fetching ${url}...`);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`      Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      return;
    }
    const content = await res.text();
    await fs.ensureDir(destDir);
    await fs.writeFile(path.join(destDir, filename), content);
    console.log(`      Saved ${filename}`);
    totalSaved++;
  } catch (error) {
    console.error(`    Error fetching ${url}:`, error);
  }
}

/**
 * Generate a safe filename from a URL or title
 */
function generateFilename(url: string, title: string): string {
  // Try to get a filename from the URL path
  const urlPath = new URL(url).pathname;
  const urlFilename = path.basename(urlPath);

  if (urlFilename && urlFilename !== '' && urlFilename !== '/') {
    // If URL already has .md extension, use it
    if (urlFilename.endsWith('.md')) {
      return urlFilename;
    }
    // Otherwise, add .md extension
    return urlFilename.replace(/[^a-zA-Z0-9-_]/g, '-') + '.md';
  }

  // Fall back to using the title
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') + '.md';
}

/**
 * Fetch Claude documentation from llms.txt and web pages
 */
async function fetchClaudeDocs(destDir: string): Promise<void> {
  console.log('Fetching Claude documentation...');
  await fs.ensureDir(destDir);

  // 1. Fetch and parse llms.txt
  console.log('  Fetching llms.txt...');
  try {
    const llmsTxtUrl = 'https://platform.claude.com/llms.txt';
    const res = await fetch(llmsTxtUrl);
    if (!res.ok) {
      console.error(`    Failed to fetch llms.txt: ${res.status} ${res.statusText}`);
    } else {
      const content = await res.text();

      // Skip saving llms-full.txt as it's excluded (raw text dump)
      console.log('    Skipped llms-full.txt (excluded - raw text dump)');
      totalSkipped++;

      // Parse and fetch relevant linked documents
      const links = parseLlmsTxt(content);
      console.log(`    Found ${links.length} relevant documentation links`);

      // Deduplicate links by URL
      const uniqueLinks = new Map<string, { title: string; url: string }>();
      for (const link of links) {
        if (!uniqueLinks.has(link.url)) {
          uniqueLinks.set(link.url, link);
        }
      }

      // Fetch each linked document
      for (const link of uniqueLinks.values()) {
        const filename = generateFilename(link.url, link.title);
        if (link.url.endsWith('.md')) {
          await fetchMarkdownFile(link.url, destDir, filename);
        } else {
          // HTML page - convert to markdown
          await fetchWebPageToMarkdown(link.url, destDir, filename);
        }
      }
    }
  } catch (error) {
    console.error('  Error processing llms.txt:', error);
  }

  // 2. Fetch Claude Code CLI documentation pages
  console.log('  Fetching Claude Code CLI documentation...');
  const claudeCodePages = [
    { url: 'https://code.claude.com/docs/en/headless', filename: 'headless.md' },
    { url: 'https://code.claude.com/docs/en/plugins', filename: 'plugins.md' },
    { url: 'https://code.claude.com/docs/en/skills', filename: 'skills.md' },
    { url: 'https://code.claude.com/docs/en/output-styles', filename: 'output-styles.md' },
    { url: 'https://code.claude.com/docs/en/hooks-guide', filename: 'hooks-guide.md' },
    { url: 'https://code.claude.com/docs/en/mcp', filename: 'mcp.md' },
    { url: 'https://code.claude.com/docs/en/troubleshooting', filename: 'troubleshooting.md' },
  ];

  for (const page of claudeCodePages) {
    await fetchWebPageToMarkdown(page.url, destDir, page.filename);
  }
}

/**
 * Remove excluded files from existing documentation directories
 */
async function removeExcludedFiles(): Promise<void> {
  console.log('=== Removing Excluded Files ===');
  const dirs = ['claude', 'codex'];
  let removedCount = 0;

  for (const dir of dirs) {
    const dirPath = path.join(DOCS_ROOT, dir);
    if (await fs.pathExists(dirPath)) {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        if (EXCLUDED_FILES.has(file)) {
          const filePath = path.join(dirPath, file);
          await fs.remove(filePath);
          console.log(`  Removed ${dir}/${file}`);
          removedCount++;
        }
      }
    }
  }

  // Also check root level files
  if (await fs.pathExists(DOCS_ROOT)) {
    const files = await fs.readdir(DOCS_ROOT);
    for (const file of files) {
      if (EXCLUDED_FILES.has(file)) {
        const filePath = path.join(DOCS_ROOT, file);
        if ((await fs.stat(filePath)).isFile()) {
          await fs.remove(filePath);
          console.log(`  Removed ${file}`);
          removedCount++;
        }
      }
    }
  }

  console.log(`Removed ${removedCount} excluded files`);
  console.log();
}

async function main(): Promise<void> {
  console.log('Starting documentation update...\n');
  await fs.ensureDir(DOCS_ROOT);

  // First, remove any existing excluded files
  await removeExcludedFiles();

  // 1. OpenAI Codex
  console.log('=== OpenAI Codex Documentation ===');
  await fetchGithubDocs('openai', 'codex', 'docs', path.join(DOCS_ROOT, 'codex'));
  console.log();

  // 3. Claude
  console.log('=== Claude Documentation ===');
  await fetchClaudeDocs(path.join(DOCS_ROOT, 'claude'));
  console.log();

  console.log('Documentation update complete!');
  console.log();
  console.log('=== SUMMARY ===');
  console.log(`Files saved: ${totalSaved}`);
  console.log(`Files skipped (excluded): ${totalSkipped}`);
  console.log(`Total excluded files configured: ${EXCLUDED_FILES.size}`);
  console.log();
  console.log('Excluded files help reduce context size and focus on ProPR-relevant documentation.');
  console.log('See comments in EXCLUDED_FILES for rationale behind each exclusion.');
}

main().catch(console.error);
