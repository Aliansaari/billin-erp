// ── Import Job Worker ──────────────────────────────────────────────────
//
// Polls `import_jobs` for queued work. Single-job-globally — if any job
// is in a non-terminal status we hold off and re-poll. Each job is
// dispatched to its source-specific orchestrator (Tally / Excel) and
// the orchestrator drives the status machine through the JSON payloads.
//
// We deliberately run inside the main Node process rather than as a
// worker_thread for Phase 4. The job orchestrators do their own DB
// transactions; isolating them in a worker thread costs us a separate
// Sequelize connection and IPC plumbing for no real gain on a single-
// tenant install. If/when this needs to scale we can swap the poll loop
// for a worker_thread without changing the orchestrator interfaces.
//
// Crash recovery: at boot, every job in a non-terminal status (parsing /
// validating / committing) is flipped to 'failed' with a clear message —
// the previous process died holding it.
//
// Public API:
//   start()      — begin polling. Idempotent.
//   stop()       — pause polling (used by tests).
//   recoverOrphans() — one-shot crash sweep, also called at boot.
//   isRunning()  — boolean, exported for tests.

const { Op } = require('sequelize');
const { ImportJob } = require('../models');

const POLL_INTERVAL_MS = 2000;
let timer = null;
let busy = false;

const NON_TERMINAL = ['parsing', 'validating', 'committing'];

async function recoverOrphans() {
  // Statuses that mean "a previous worker had this job and hadn't finished
  // it" — flip them all. We deliberately don't touch awaiting_confirmation
  // (that's a legitimate pause waiting on user input).
  const [count] = await ImportJob.update(
    {
      status: 'failed',
      error_message: 'Worker crashed mid-job, please re-import.',
      completed_at: new Date(),
    },
    { where: { status: { [Op.in]: NON_TERMINAL } } },
  );
  if (count > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[importJobWorker] Crash recovery: marked ${count} orphan jobs as failed.`);
  }
  return count;
}

// Dispatch a single picked job. Orchestrators are looked up lazily so
// circular requires / unimplemented orchestrators don't crash the worker.
async function dispatch(job) {
  // Phase 4 has no real orchestrators yet — sales/excel come in Phase 5/6.
  // For Phase 4 self-test we accept a synthetic 'noop' source via the
  // profile_json.test_mode flag so we can exercise the lifecycle end-to-end
  // without uploading a real file.
  if (job.profile_json && job.profile_json.test_mode === 'noop') {
    return runNoopJob(job);
  }

  let orchestrator = null;
  try {
    if (job.source === 'tally') {
      // eslint-disable-next-line global-require
      orchestrator = require('./tallyImportOrchestrator');
    } else if (String(job.source).startsWith('excel_')) {
      // eslint-disable-next-line global-require
      orchestrator = require('./excelImportOrchestrator');
    }
  } catch (e) {
    // Orchestrator file may not exist yet (Phase 4 ships before 5/6).
    orchestrator = null;
  }

  if (!orchestrator || typeof orchestrator.run !== 'function') {
    await job.update({
      status: 'failed',
      error_message: `No orchestrator implemented for source '${job.source}'. Wire up in Phase 5/6.`,
      completed_at: new Date(),
    });
    return;
  }

  try {
    await orchestrator.run(job);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[importJobWorker] Job #${job.id} crashed:`, err);
    try {
      await job.reload();
      if (!['done', 'failed', 'cancelled'].includes(job.status)) {
        await job.update({
          status: 'failed',
          error_message: err.message || String(err),
          completed_at: new Date(),
        });
      }
    } catch (_) { /* swallow secondary errors so the worker keeps polling */ }
  }
}

// Synthetic no-op job — walks the status machine with sleeps. Used by
// the Phase 4 self-test to verify pickup, progress, and completion.
async function runNoopJob(job) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await job.update({ status: 'parsing',    progress_pct: 10, phase_message: 'Parsing (test)', started_at: new Date() });
  await wait(50);
  await job.update({ status: 'validating', progress_pct: 40, phase_message: 'Validating (test)' });
  await wait(50);
  await job.update({ status: 'committing', progress_pct: 80, phase_message: 'Committing (test)' });
  await wait(50);
  await job.update({
    status: 'done', progress_pct: 100, phase_message: 'Complete',
    completed_at: new Date(),
    result_summary_json: { ok: true, note: 'noop test run' },
  });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // Single-job globally: if anything else is in a running/awaiting state,
    // skip this tick.
    const inProgress = await ImportJob.count({
      where: { status: { [Op.in]: NON_TERMINAL } },
    });
    if (inProgress > 0) return;

    const job = await ImportJob.findOne({
      where: { status: 'queued' },
      order: [['id', 'ASC']],
    });
    if (!job) return;

    await dispatch(job);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[importJobWorker] tick error:', err);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function isRunning() { return !!timer; }

module.exports = { start, stop, isRunning, recoverOrphans, _tick: tick, _runNoopJob: runNoopJob };
