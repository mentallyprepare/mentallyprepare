#!/usr/bin/env node
// Exit nonzero for stale offsite uploads or restore checks. No secret output.
const { readStatus } = require('./backup-status');

function checkBackupHealth(status = readStatus(), now = Date.now()) {
  const uploadAge = now - Date.parse(status.lastOffsiteSuccessAt);
  const restoreAge = now - Date.parse(status.lastRestoreSuccessAt);
  const problems = [];
  if (!Number.isFinite(uploadAge) || uploadAge < 0 || uploadAge > 25 * 60 * 60 * 1000) problems.push('offsite_upload_stale');
  if (!Number.isFinite(restoreAge) || restoreAge < 0 || restoreAge > 8 * 24 * 60 * 60 * 1000) problems.push('restore_check_stale');
  if (status.lastAttemptOk === false) problems.push('last_backup_attempt_failed');
  if (status.lastRestoreFailureCode) problems.push('last_restore_check_failed');
  return problems;
}

if (require.main === module) {
  const problems = checkBackupHealth();
  console.log(problems.length ? `Backup health failed: ${problems.join(', ')}` : 'Backup health ok');
  process.exitCode = problems.length ? 1 : 0;
}

module.exports = { checkBackupHealth };
