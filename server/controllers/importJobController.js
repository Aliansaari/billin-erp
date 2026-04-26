// ── Import Job Controller ──────────────────────────────────────────────
//
// Thin orchestration layer for the import flow. The actual parsing /
// validation / commit happens inside the orchestrators driven by the
// importJobWorker. This controller's job:
//   • accept the upload + profile, queue an import_job
//   • expose status / preview / mapping payload for the polling UI
//   • accept user confirmation to advance from awaiting_confirmation
//   • accept user cancel
//   • serve the rejected-rows Excel
//
// Single-job-globally: a POST to /api/imports while another job is in a
// non-terminal status returns 409 with a clear message. The UI surfaces
// this as a "Another import is in progress" toast.

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Op } = require('sequelize');
const { ImportJob, ImportBatch } = require('../models');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'imports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB ceiling
});
exports.uploadMiddleware = upload.single('file');

const NON_TERMINAL = ['queued', 'parsing', 'validating', 'awaiting_confirmation', 'committing'];

function safeProfile(input) {
  if (!input) return {};
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return input;
}

// ── POST /api/imports ──────────────────────────────────────────────────
// Creates an import_job. Single-job-globally enforced.
exports.create = async (req, res) => {
  try {
    const inProgress = await ImportJob.count({
      where: { status: { [Op.in]: NON_TERMINAL } },
    });
    if (inProgress > 0) {
      // If a file came in, drop it — we're rejecting the upload.
      if (req.file && req.file.path) {
        try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
      }
      return res.status(409).json({
        error: 'Another import is in progress. Please wait for it to finish or cancel it.',
      });
    }

    const { source } = req.body || {};
    if (!source) return res.status(400).json({ error: 'source is required.' });

    const profile = safeProfile(req.body && req.body.profile);

    // Test-mode jobs (used by self-tests) don't need a file.
    if (!profile.test_mode && !req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const job = await ImportJob.create({
      source,
      status: 'queued',
      profile_json: profile,
      input_file_path: req.file ? req.file.path : null,
      created_by: req.user && req.user.user_id,
    });
    res.status(201).json({ job_id: job.id, status: job.status });
  } catch (err) {
    console.error('importJob create error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── GET /api/imports/:id ───────────────────────────────────────────────
exports.getById = async (req, res) => {
  try {
    const job = await ImportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(job);
  } catch (err) {
    console.error('importJob getById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /api/imports ───────────────────────────────────────────────────
// Recent jobs — used by the UI to detect a "stuck" job from a prior
// browser session and resume polling on it.
exports.list = async (req, res) => {
  try {
    const rows = await ImportJob.findAll({
      order: [['id', 'DESC']],
      limit: 20,
      attributes: ['id', 'source', 'status', 'progress_pct', 'phase_message', 'created_at', 'completed_at'],
    });
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /api/imports/:id/confirm ──────────────────────────────────────
// Advances a job from awaiting_confirmation. Body may include the user's
// confirmed mapping (Tally) or unchecked-update opt-outs (Excel). The
// orchestrator picks these up on resume via job.profile_json.user_choices.
exports.confirm = async (req, res) => {
  try {
    const job = await ImportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status !== 'awaiting_confirmation') {
      return res.status(400).json({ error: `Cannot confirm a job in status '${job.status}'.` });
    }
    const choices = req.body || {};
    await job.update({
      profile_json: { ...(job.profile_json || {}), user_choices: choices },
      // Hand back to 'queued' so the worker picks it up and resumes.
      status: 'queued',
      phase_message: 'Resuming after confirmation…',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('importJob confirm error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── POST /api/imports/:id/cancel ───────────────────────────────────────
// Sets status='cancelled'. Worker checks this between batches and aborts
// gracefully. If the job is already terminal, this is a no-op.
exports.cancel = async (req, res) => {
  try {
    const job = await ImportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return res.json({ ok: true, status: job.status });
    }
    await job.update({
      status: 'cancelled',
      completed_at: new Date(),
      phase_message: 'Cancelled by user',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /api/imports/:id/rejected-rows ─────────────────────────────────
// Streams the rejected-rows Excel generated at finalize.
exports.downloadRejected = async (req, res) => {
  try {
    const job = await ImportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (!job.rejected_rows_path || !fs.existsSync(job.rejected_rows_path)) {
      return res.status(404).json({ error: 'No rejected-rows file for this job.' });
    }
    res.download(job.rejected_rows_path, `rejected-rows-${job.id}.xlsx`);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /api/imports/:id/batches ───────────────────────────────────────
// Per-row trail. Useful for support diagnostics.
exports.batches = async (req, res) => {
  try {
    const rows = await ImportBatch.findAll({
      where: { import_job_id: req.params.id },
      order: [['id', 'ASC']],
      limit: 5000,
    });
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
