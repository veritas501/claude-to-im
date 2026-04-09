/**
 * MCP Server for cron job management.
 *
 * Standalone stdio process spawned by Claude CLI.
 * Provides a unified `cron` tool with actions: add, list, remove, update, status.
 *
 * Channel context is auto-injected via CTI_BRIDGE_* environment variables
 * set by the daemon's LLM provider before spawning the CLI subprocess.
 *
 * Storage: ~/.claude-to-im/data/cron.json (shared with the daemon scheduler).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Cron } from 'croner';

// ── Paths ──

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const DATA_DIR = path.join(CTI_HOME, 'data');
const CRON_FILE = path.join(DATA_DIR, 'cron.json');

// ── Types ──

interface CronScheduleCron { kind: 'cron'; expr: string; tz?: string }
interface CronScheduleAt { kind: 'at'; at: string }
interface CronScheduleEvery { kind: 'every'; everyMs: number }

type CronSchedule = CronScheduleCron | CronScheduleAt | CronScheduleEvery;

interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors: number;
}

interface CronJob {
  id: string;
  name?: string;
  schedule: CronSchedule;
  prompt: string;
  deleteAfterRun: boolean;
  channelType: string;
  chatId: string;
  userId?: string;
  displayName?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  state: CronJobState;
}

interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

// ── Store helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function loadStore(): CronStoreFile {
  try {
    const raw = fs.readFileSync(CRON_FILE, 'utf-8');
    return JSON.parse(raw) as CronStoreFile;
  } catch {
    return { version: 1, jobs: [] };
  }
}

function saveStore(store: CronStoreFile): void {
  ensureDir(DATA_DIR);
  const tmp = CRON_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, CRON_FILE);
}

// ── Schedule helpers ──

function computeNextRunAtMs(schedule: CronSchedule, afterMs?: number): number | undefined {
  const now = afterMs ?? Date.now();

  switch (schedule.kind) {
    case 'cron': {
      try {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz });
        const next = cron.nextRun(new Date(now));
        return next ? next.getTime() : undefined;
      } catch {
        return undefined;
      }
    }
    case 'at': {
      const ts = new Date(schedule.at).getTime();
      return isNaN(ts) ? undefined : ts;
    }
    case 'every': {
      return now + schedule.everyMs;
    }
  }
}

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'cron':
      return `cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
    case 'at':
      return `at: ${schedule.at}`;
    case 'every': {
      const secs = schedule.everyMs / 1000;
      if (secs < 60) return `every ${secs}s`;
      if (secs < 3600) return `every ${Math.round(secs / 60)}min`;
      return `every ${Math.round(secs / 3600)}h`;
    }
  }
}

function formatNextRun(ms?: number): string {
  if (!ms) return 'N/A';
  return new Date(ms).toISOString();
}

// ── Bridge context from env ──

function getBridgeContext(): { channelType: string; chatId: string; userId?: string; displayName?: string } | null {
  const channelType = process.env.CTI_BRIDGE_CHANNEL_TYPE;
  const chatId = process.env.CTI_BRIDGE_CHAT_ID;
  if (!channelType || !chatId) return null;
  return {
    channelType,
    chatId,
    userId: process.env.CTI_BRIDGE_USER_ID || undefined,
    displayName: process.env.CTI_BRIDGE_DISPLAY_NAME || undefined,
  };
}

// ── Validation helpers ──

function validateCronExpr(expr: string): string | null {
  try {
    new Cron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid cron expression';
  }
}

function validateSchedule(schedule: unknown): { valid: true; schedule: CronSchedule } | { valid: false; error: string } {
  if (!schedule || typeof schedule !== 'object') {
    return { valid: false, error: 'schedule is required and must be an object with kind: "cron" | "at" | "every"' };
  }
  const s = schedule as Record<string, unknown>;

  if (s.kind === 'cron') {
    if (typeof s.expr !== 'string' || !s.expr.trim()) {
      return { valid: false, error: 'schedule.expr is required for kind "cron"' };
    }
    const err = validateCronExpr(s.expr);
    if (err) return { valid: false, error: `Invalid cron expression "${s.expr}": ${err}` };
    return {
      valid: true,
      schedule: { kind: 'cron', expr: s.expr, tz: typeof s.tz === 'string' ? s.tz : undefined },
    };
  }

  if (s.kind === 'at') {
    if (typeof s.at !== 'string' || !s.at.trim()) {
      return { valid: false, error: 'schedule.at is required for kind "at" (ISO-8601 timestamp)' };
    }
    const ts = new Date(s.at).getTime();
    if (isNaN(ts)) return { valid: false, error: `Invalid timestamp: "${s.at}"` };
    return { valid: true, schedule: { kind: 'at', at: s.at } };
  }

  if (s.kind === 'every') {
    const ms = typeof s.everyMs === 'number' ? s.everyMs : parseInt(String(s.everyMs), 10);
    if (isNaN(ms) || ms < 10_000) {
      return { valid: false, error: 'schedule.everyMs must be a number >= 10000 (10 seconds minimum)' };
    }
    return { valid: true, schedule: { kind: 'every', everyMs: ms } };
  }

  return { valid: false, error: `Unknown schedule kind: "${s.kind}". Must be "cron", "at", or "every"` };
}

// ── Flat-params recovery (handles models that flatten nested objects) ──

const RECOVERABLE_JOB_KEYS = new Set(['name', 'schedule', 'prompt', 'deleteAfterRun']);

function recoverFlatParams(params: Record<string, unknown>): Record<string, unknown> {
  if (params.job && typeof params.job === 'object' && Object.keys(params.job as object).length > 0) {
    return params;
  }
  // Check if job-level fields are at top level
  const hasTopLevel = Object.keys(params).some(k => RECOVERABLE_JOB_KEYS.has(k));
  if (!hasTopLevel) return params;

  const synthetic: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    if (RECOVERABLE_JOB_KEYS.has(key)) {
      synthetic[key] = params[key];
    }
  }
  return { ...params, job: synthetic };
}

// ── Action handlers ──

function handleAdd(params: Record<string, unknown>): string {
  const recovered = recoverFlatParams(params);
  const jobInput = recovered.job as Record<string, unknown> | undefined;
  if (!jobInput || !jobInput.prompt) {
    return 'Error: job.prompt is required. Provide the task prompt that should be executed on schedule.';
  }

  const prompt = String(jobInput.prompt).trim();
  if (!prompt) return 'Error: prompt cannot be empty.';

  const title = typeof jobInput.name === 'string' ? jobInput.name.trim() : '';
  if (!title) return 'Error: job.name (title) is required. Provide a brief title (~10 chars) for this cron job.';
  if (title.length > 20) return 'Error: job.name (title) must be 20 characters or fewer.';

  const scheduleResult = validateSchedule(jobInput.schedule);
  if (!scheduleResult.valid) return `Error: ${scheduleResult.error}`;

  const ctx = getBridgeContext();
  if (!ctx) {
    return 'Error: No bridge context available. This tool should be called from an IM channel through the claude-to-im bridge.';
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID().slice(0, 8);
  const schedule = scheduleResult.schedule;
  const nextRunAtMs = computeNextRunAtMs(schedule);

  const job: CronJob = {
    id,
    name: title,
    schedule,
    prompt,
    deleteAfterRun: schedule.kind === 'at' ? true : (jobInput.deleteAfterRun === true),
    channelType: ctx.channelType,
    chatId: ctx.chatId,
    userId: ctx.userId,
    displayName: ctx.displayName,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    state: {
      nextRunAtMs,
      consecutiveErrors: 0,
    },
  };

  const store = loadStore();
  store.jobs.push(job);
  saveStore(store);

  const lines = [
    `Created cron job: ${id}`,
    `Schedule: ${formatSchedule(schedule)}`,
    `Prompt: ${prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt}`,
    `Next run: ${formatNextRun(nextRunAtMs)}`,
    `Channel: ${ctx.channelType}:${ctx.chatId}`,
    job.deleteAfterRun ? '(One-shot: will be deleted after execution)' : '(Recurring)',
  ];
  return lines.join('\n');
}

function handleList(params: Record<string, unknown>): string {
  const store = loadStore();
  const ctx = getBridgeContext();
  const showAll = params.all === true;

  let jobs = store.jobs;
  if (!showAll && ctx) {
    jobs = jobs.filter(j => j.channelType === ctx.channelType && j.chatId === ctx.chatId);
  }

  if (jobs.length === 0) {
    return showAll ? 'No cron jobs found.' : 'No cron jobs for this channel. Use all=true to see all jobs.';
  }

  const lines = [`Found ${jobs.length} job(s):\n`];
  for (const job of jobs) {
    const status = job.enabled ? 'enabled' : 'disabled';
    const lastRun = job.state.lastRunAtMs
      ? `last: ${new Date(job.state.lastRunAtMs).toISOString()} (${job.state.lastRunStatus || 'unknown'})`
      : 'never run';
    lines.push(
      `[${job.id}] ${job.name || '(unnamed)'} — ${status}`,
      `  Schedule: ${formatSchedule(job.schedule)}`,
      `  Prompt: ${job.prompt.length > 60 ? job.prompt.slice(0, 60) + '...' : job.prompt}`,
      `  Next: ${formatNextRun(job.state.nextRunAtMs)} | ${lastRun}`,
      `  Channel: ${job.channelType}:${job.chatId}`,
      job.state.consecutiveErrors > 0 ? `  ⚠ ${job.state.consecutiveErrors} consecutive error(s)` : '',
      '',
    );
  }
  return lines.filter(Boolean).join('\n');
}

function handleRemove(params: Record<string, unknown>): string {
  const jobId = (params.jobId || params.id) as string;
  if (!jobId) return 'Error: jobId is required.';

  const store = loadStore();
  const idx = store.jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return `Error: Job "${jobId}" not found.`;

  const removed = store.jobs.splice(idx, 1)[0];
  saveStore(store);
  return `Removed job "${jobId}" (${removed.name || removed.prompt.slice(0, 40)}).`;
}

function handleUpdate(params: Record<string, unknown>): string {
  const jobId = (params.jobId || params.id) as string;
  if (!jobId) return 'Error: jobId is required.';

  const patch = params.patch as Record<string, unknown> | undefined;
  if (!patch || Object.keys(patch).length === 0) return 'Error: patch is required with fields to update.';

  const store = loadStore();
  const job = store.jobs.find(j => j.id === jobId);
  if (!job) return `Error: Job "${jobId}" not found.`;

  if (patch.name !== undefined) job.name = String(patch.name);
  if (patch.prompt !== undefined) job.prompt = String(patch.prompt);
  if (patch.enabled !== undefined) job.enabled = Boolean(patch.enabled);
  if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = Boolean(patch.deleteAfterRun);

  if (patch.schedule !== undefined) {
    const result = validateSchedule(patch.schedule);
    if (!result.valid) return `Error: ${result.error}`;
    job.schedule = result.schedule;
    job.state.nextRunAtMs = computeNextRunAtMs(result.schedule);
  }

  job.updatedAt = new Date().toISOString();
  saveStore(store);
  return `Updated job "${jobId}".\nSchedule: ${formatSchedule(job.schedule)}\nNext: ${formatNextRun(job.state.nextRunAtMs)}`;
}

function handleStatus(): string {
  const store = loadStore();
  const total = store.jobs.length;
  const enabled = store.jobs.filter(j => j.enabled).length;
  const errored = store.jobs.filter(j => j.state.consecutiveErrors > 0).length;

  const nextJob = store.jobs
    .filter(j => j.enabled && j.state.nextRunAtMs)
    .sort((a, b) => (a.state.nextRunAtMs || Infinity) - (b.state.nextRunAtMs || Infinity))[0];

  const lines = [
    `Cron Status:`,
    `  Total jobs: ${total}`,
    `  Enabled: ${enabled}`,
    `  With errors: ${errored}`,
    `  Store: ${CRON_FILE}`,
  ];
  if (nextJob) {
    lines.push(`  Next fire: ${formatNextRun(nextJob.state.nextRunAtMs)} — [${nextJob.id}] ${nextJob.name || nextJob.prompt.slice(0, 40)}`);
  }
  return lines.join('\n');
}

// ── MCP Server setup ──

const server = new McpServer({
  name: 'claude-to-im-cron',
  version: '1.0.0',
});

server.tool(
  'cron',
  `Manage scheduled/cron jobs for the claude-to-im bridge. Jobs execute prompts through Claude and deliver results to the IM channel where the job was created.

Actions:
- add: Create a new scheduled job
- list: List jobs (current channel by default, or all)
- remove: Delete a job by ID
- update: Modify a job's schedule, prompt, or status
- status: Show scheduler overview

Schedule types:
- {kind:"cron", expr:"0 9 * * *", tz:"Asia/Shanghai"} — standard 5-field cron
- {kind:"at", at:"2026-04-08T15:00:00+08:00"} — one-shot at specific time
- {kind:"every", everyMs:1800000} — recurring interval (min 10s)`,
  {
    action: z.enum(['add', 'list', 'remove', 'update', 'status']),
    job: z.optional(z.object({
      name: z.optional(z.string()),
      schedule: z.optional(z.any()),
      prompt: z.optional(z.string()),
      deleteAfterRun: z.optional(z.boolean()),
    })),
    jobId: z.optional(z.string()),
    id: z.optional(z.string()),
    patch: z.optional(z.record(z.any())),
    all: z.optional(z.boolean()),
    // Flat-params support: these may appear at top level if model flattens nested objects
    name: z.optional(z.string()),
    schedule: z.optional(z.any()),
    prompt: z.optional(z.string()),
    deleteAfterRun: z.optional(z.boolean()),
  },
  async (params) => {
    let result: string;
    try {
      switch (params.action) {
        case 'add':
          result = handleAdd(params as Record<string, unknown>);
          break;
        case 'list':
          result = handleList(params as Record<string, unknown>);
          break;
        case 'remove':
          result = handleRemove(params as Record<string, unknown>);
          break;
        case 'update':
          result = handleUpdate(params as Record<string, unknown>);
          break;
        case 'status':
          result = handleStatus();
          break;
        default:
          result = `Unknown action: "${params.action}". Use: add, list, remove, update, status`;
      }
    } catch (e) {
      result = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { content: [{ type: 'text' as const, text: result }] };
  },
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[mcp-server] Fatal:', err);
  process.exit(1);
});
