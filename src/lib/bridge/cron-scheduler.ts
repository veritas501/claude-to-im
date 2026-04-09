/**
 * Cron Scheduler — runs inside the daemon process.
 *
 * Uses a smart timer: computes delay to the next due job rather than
 * fixed-interval polling. Max wake interval is 60 seconds (safety net).
 *
 * Shared storage: ~/.claude-to-im/data/cron.json (same file as MCP server).
 * The scheduler reads this file on every tick to pick up changes made by
 * the MCP server (which runs in a separate process).
 *
 * Job execution: creates an isolated session, sends the prompt through
 * Claude via the conversation engine, and delivers the result to the
 * originating IM channel.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Cron } from 'croner';

import { getBridgeContext } from './context.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import { getState, deliverResponse } from './bridge-manager.js';
import { deliver } from './delivery-layer.js';
import type { ChannelAddress } from './types.js';

// ── Constants ──

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const CRON_FILE = path.join(CTI_HOME, 'data', 'cron.json');
const MAX_TIMER_DELAY_MS = 60_000;
const MIN_REFIRE_GAP_MS = 2_000;
const MAX_STARTUP_CATCHUP = 3;
const STARTUP_CATCHUP_STAGGER_MS = 5_000;

const BACKOFF_SCHEDULE_MS = [
  30_000,       // 1st error → 30s
  60_000,       // 2nd error → 1 min
  5 * 60_000,   // 3rd error → 5 min
  15 * 60_000,  // 4th error → 15 min
  60 * 60_000,  // 5th+ error → 60 min
];

// ── Types (mirror mcp-server.ts) ──

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

// ── Scheduler state ──

interface SchedulerState {
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  executingJobs: Set<string>;  // job IDs currently running
}

const state: SchedulerState = {
  running: false,
  timer: null,
  executingJobs: new Set(),
};

// ── Store I/O ──

function loadStore(): CronStoreFile {
  try {
    const raw = fs.readFileSync(CRON_FILE, 'utf-8');
    return JSON.parse(raw) as CronStoreFile;
  } catch {
    return { version: 1, jobs: [] };
  }
}

function saveStore(store: CronStoreFile): void {
  const dir = path.dirname(CRON_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = CRON_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, CRON_FILE);
}

// ── Schedule computation ──

// Cache parsed cron expressions (max 128)
const cronCache = new Map<string, Cron>();
const CRON_CACHE_MAX = 128;

function getCronInstance(expr: string, tz?: string): Cron {
  const key = `${tz || ''}\0${expr}`;
  let c = cronCache.get(key);
  if (!c) {
    if (cronCache.size >= CRON_CACHE_MAX) {
      // Evict oldest entry
      const firstKey = cronCache.keys().next().value;
      if (firstKey) cronCache.delete(firstKey);
    }
    c = new Cron(expr, { timezone: tz });
    cronCache.set(key, c);
  }
  return c;
}

function computeNextRunAtMs(schedule: CronSchedule, afterMs?: number): number | undefined {
  const now = afterMs ?? Date.now();
  switch (schedule.kind) {
    case 'cron': {
      try {
        const cron = getCronInstance(schedule.expr, schedule.tz);
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

// ── Timer management ──

function armTimer(): void {
  if (!state.running) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const store = loadStore();
  const now = Date.now();

  // Find earliest nextRunAtMs among enabled jobs
  let earliest = Infinity;
  for (const job of store.jobs) {
    if (!job.enabled || !job.state.nextRunAtMs) continue;
    if (state.executingJobs.has(job.id)) continue;
    if (job.state.nextRunAtMs < earliest) {
      earliest = job.state.nextRunAtMs;
    }
  }

  const delay = earliest === Infinity
    ? MAX_TIMER_DELAY_MS
    : Math.max(earliest - now, 0);
  const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
  const safeDelay = Math.max(clampedDelay, MIN_REFIRE_GAP_MS);

  state.timer = setTimeout(() => {
    void tick().catch(err => {
      console.error('[cron-scheduler] tick error:', err instanceof Error ? err.message : err);
      // Re-arm timer even on error
      armTimer();
    });
  }, safeDelay);
}

async function tick(): Promise<void> {
  if (!state.running) return;

  const store = loadStore();
  const now = Date.now();
  let changed = false;

  // Find due jobs
  const dueJobs: CronJob[] = [];
  for (const job of store.jobs) {
    if (!job.enabled) continue;
    if (state.executingJobs.has(job.id)) continue;
    if (job.state.nextRunAtMs && now >= job.state.nextRunAtMs) {
      dueJobs.push(job);
    }
  }

  // Execute due jobs (async, don't block)
  for (const job of dueJobs) {
    state.executingJobs.add(job.id);
    executeJob(job, store).finally(() => {
      state.executingJobs.delete(job.id);
      // Re-arm after job completes (may have changed nextRunAtMs)
      armTimer();
    });
  }

  // Recompute nextRunAtMs for non-executing jobs with stale nextRunAtMs
  for (const job of store.jobs) {
    if (!job.enabled) continue;
    if (state.executingJobs.has(job.id)) continue;
    if (job.state.nextRunAtMs && now >= job.state.nextRunAtMs) {
      // Past due but not picked up (shouldn't happen, but safety)
      const next = computeNextRunAtMs(job.schedule, now);
      if (next !== job.state.nextRunAtMs) {
        job.state.nextRunAtMs = next;
        job.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) {
    saveStore(store);
  }

  // Re-arm timer
  armTimer();
}

// ── Job execution ──

async function executeJob(job: CronJob, store: CronStoreFile): Promise<void> {
  const startMs = Date.now();
  console.log(`[cron-scheduler] Executing job ${job.id}: ${job.prompt.slice(0, 60)}`);

  const bmState = getState();
  const adapter = bmState.adapters.get(job.channelType);
  if (!adapter || !adapter.isRunning()) {
    const error = `Adapter "${job.channelType}" not available or not running`;
    console.warn(`[cron-scheduler] ${error} for job ${job.id}`);
    updateJobState(store, job.id, {
      lastRunAtMs: startMs,
      lastRunStatus: 'skipped',
      lastError: error,
      consecutiveErrors: job.state.consecutiveErrors + 1,
    });
    applyBackoff(store, job);
    return;
  }

  const address: ChannelAddress = {
    channelType: job.channelType,
    chatId: job.chatId,
    userId: job.userId,
    displayName: job.displayName,
  };

  // Send "executing" notification
  try {
    await deliver(adapter, {
      address,
      text: `⏰ Cron [${job.name || job.id}]`,
      parseMode: 'plain',
    });
  } catch { /* best effort */ }

  // Create an isolated binding for this execution
  const tempBinding = router.createBinding(address);

  try {
    // Execute prompt through Claude with auto-approve
    // (cron jobs can't interactively approve permissions)
    const result = await engine.processMessage(
      { ...tempBinding, mode: 'code' as const },
      job.prompt,
      undefined,  // no permission callback (auto-approve handled by LLM provider)
      undefined,  // no abort signal
      undefined,  // no files
      undefined,  // no partial text
      undefined,  // no tool event
      address,    // bridge context for MCP tools
    );

    const durationMs = Date.now() - startMs;

    if (result.responseText) {
      // Deliver result to the channel
      await deliverResponse(adapter, address, result.responseText, tempBinding.codepilotSessionId);
    } else if (result.hasError) {
      await deliver(adapter, {
        address,
        text: `⚠️ Cron job [${job.id}] error: ${result.errorMessage}`,
        parseMode: 'plain',
      });
    }

    updateJobState(store, job.id, {
      lastRunAtMs: startMs,
      lastRunStatus: result.hasError ? 'error' : 'ok',
      lastError: result.hasError ? result.errorMessage : undefined,
      lastDurationMs: durationMs,
      consecutiveErrors: result.hasError ? job.state.consecutiveErrors + 1 : 0,
    });

    if (result.hasError) {
      applyBackoff(store, job);
    } else {
      // Compute next run normally
      computeAndSetNextRun(store, job);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[cron-scheduler] Job ${job.id} execution error:`, errMsg);

    try {
      await deliver(adapter, {
        address,
        text: `⚠️ Cron job [${job.id}] failed: ${errMsg}`,
        parseMode: 'plain',
      });
    } catch { /* best effort */ }

    updateJobState(store, job.id, {
      lastRunAtMs: startMs,
      lastRunStatus: 'error',
      lastError: errMsg,
      lastDurationMs: Date.now() - startMs,
      consecutiveErrors: job.state.consecutiveErrors + 1,
    });
    applyBackoff(store, job);
  }

  // Handle deleteAfterRun
  const storeReloaded = loadStore();
  const jobAfter = storeReloaded.jobs.find(j => j.id === job.id);
  if (jobAfter?.deleteAfterRun) {
    storeReloaded.jobs = storeReloaded.jobs.filter(j => j.id !== job.id);
    saveStore(storeReloaded);
    console.log(`[cron-scheduler] One-shot job ${job.id} deleted after execution`);
  }
}

function updateJobState(store: CronStoreFile, jobId: string, updates: Partial<CronJobState>): void {
  const job = store.jobs.find(j => j.id === jobId);
  if (!job) return;
  Object.assign(job.state, updates);
  job.updatedAt = new Date().toISOString();
  saveStore(store);
}

function applyBackoff(store: CronStoreFile, job: CronJob): void {
  const errors = job.state.consecutiveErrors;
  const backoffMs = BACKOFF_SCHEDULE_MS[Math.min(errors - 1, BACKOFF_SCHEDULE_MS.length - 1)] || BACKOFF_SCHEDULE_MS[0];
  const nextRunAtMs = Date.now() + backoffMs;

  const storeJob = store.jobs.find(j => j.id === job.id);
  if (storeJob) {
    storeJob.state.nextRunAtMs = nextRunAtMs;
    storeJob.updatedAt = new Date().toISOString();
    saveStore(store);
  }
  console.log(`[cron-scheduler] Job ${job.id} backoff: ${backoffMs / 1000}s (${errors} consecutive errors)`);
}

function computeAndSetNextRun(store: CronStoreFile, job: CronJob): void {
  const storeJob = store.jobs.find(j => j.id === job.id);
  if (!storeJob) return;

  if (storeJob.deleteAfterRun) {
    // Will be deleted, no next run
    storeJob.state.nextRunAtMs = undefined;
  } else {
    const afterMs = storeJob.schedule.kind === 'every'
      ? Date.now()  // every: next = now + interval
      : Date.now(); // cron: next occurrence after now
    storeJob.state.nextRunAtMs = computeNextRunAtMs(storeJob.schedule, afterMs);
  }

  storeJob.updatedAt = new Date().toISOString();
  saveStore(store);
}

// ── Startup catchup ──

async function startupCatchup(): Promise<void> {
  const store = loadStore();
  const now = Date.now();

  // Find jobs that were missed (nextRunAtMs < now, enabled, not deleteAfterRun that was already past)
  const missedJobs = store.jobs
    .filter(j => j.enabled && j.state.nextRunAtMs && j.state.nextRunAtMs < now)
    .sort((a, b) => (a.state.nextRunAtMs || 0) - (b.state.nextRunAtMs || 0))
    .slice(0, MAX_STARTUP_CATCHUP);

  if (missedJobs.length > 0) {
    console.log(`[cron-scheduler] Startup catchup: ${missedJobs.length} missed job(s)`);
  }

  for (let i = 0; i < missedJobs.length; i++) {
    if (!state.running) break;
    if (i > 0) {
      await new Promise(r => setTimeout(r, STARTUP_CATCHUP_STAGGER_MS));
    }
    const job = missedJobs[i];
    console.log(`[cron-scheduler] Catchup executing job ${job.id}`);
    state.executingJobs.add(job.id);
    try {
      await executeJob(job, loadStore());
    } finally {
      state.executingJobs.delete(job.id);
    }
  }

  // Recompute nextRunAtMs for remaining missed jobs (that weren't caught up)
  const storeAfter = loadStore();
  let changed = false;
  for (const job of storeAfter.jobs) {
    if (!job.enabled) continue;
    if (job.state.nextRunAtMs && job.state.nextRunAtMs < now) {
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveStore(storeAfter);
}

// ── Public API ──

/**
 * Start the cron scheduler.
 * Should be called after the bridge manager has started.
 */
export async function start(): Promise<void> {
  if (state.running) return;
  state.running = true;

  console.log('[cron-scheduler] Starting...');

  // Initialize nextRunAtMs for jobs that don't have it
  const store = loadStore();
  let changed = false;
  for (const job of store.jobs) {
    if (job.enabled && !job.state.nextRunAtMs) {
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule);
      changed = true;
    }
  }
  if (changed) saveStore(store);

  // Run startup catchup (async, non-blocking)
  startupCatchup().catch(err => {
    console.error('[cron-scheduler] Startup catchup error:', err instanceof Error ? err.message : err);
  }).finally(() => {
    // Arm timer after catchup completes
    armTimer();
  });

  console.log(`[cron-scheduler] Started (${store.jobs.filter(j => j.enabled).length} enabled jobs)`);
}

/**
 * Stop the cron scheduler.
 */
export function stop(): void {
  if (!state.running) return;
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  console.log('[cron-scheduler] Stopped');
}
