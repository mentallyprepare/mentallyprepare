#!/usr/bin/env node
'use strict';

// Read-only SQLite storage audit. This script reports schema and operational
// posture only; it never selects private row content or prints secret values.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const IS_PROD = process.env.NODE_ENV === 'production';
const includeCounts = process.argv.includes('--include-counts');
const jsonOnly = process.argv.includes('--json');

function resolveDbPath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const dataDir = process.env.DATA_DIR
    || process.env.RAILWAY_VOLUME_MOUNT_PATH
    || (IS_PROD ? '/data/db' : path.join(__dirname, '..'));
  return path.join(dataDir, 'mentally-prepare.db');
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function envConfigured(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
}

function classifyColumn(name) {
  const normalized = String(name).toLowerCase();
  if (/(password|token|secret|subscription)/.test(normalized)) return 'credential_or_token';
  if (/(text|content|reason|prompt|message)/.test(normalized)) return 'private_content_candidate';
  if (/(email|name|college|photo|gender|timezone|region)/.test(normalized)) return 'personal_data_candidate';
  if (/(score|archetype|mood|choice|preference)/.test(normalized)) return 'sensitive_profile_candidate';
  return null;
}

function main() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`Storage audit failed: database not found at ${dbPath}`);
    process.exitCode = 2;
    return;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    const foreignKeyViolations = db.pragma('foreign_key_check');
    const userVersion = db.pragma('user_version', { simple: true });
    const journalMode = db.pragma('journal_mode', { simple: true });
    const tableNames = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);

    const tables = tableNames.map((tableName) => {
      const columns = db.pragma(`table_info(${quoteIdentifier(tableName)})`);
      const foreignKeys = db.pragma(`foreign_key_list(${quoteIdentifier(tableName)})`);
      const indexes = db.pragma(`index_list(${quoteIdentifier(tableName)})`);
      const sensitiveColumns = columns
        .map((column) => ({ name: column.name, classification: classifyColumn(column.name) }))
        .filter((column) => column.classification);
      const table = {
        name: tableName,
        columnCount: columns.length,
        foreignKeyCount: foreignKeys.length,
        cascadeDeleteForeignKeys: foreignKeys.filter((fk) => String(fk.on_delete).toUpperCase() === 'CASCADE').length,
        indexCount: indexes.length,
        sensitiveColumns,
      };
      if (includeCounts) {
        table.rowCount = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get().count;
      }
      return table;
    });

    const migrationTable = tableNames.find((name) => /^(schema_)?migrations?$/i.test(name));
    const resolvedDataDir = path.dirname(dbPath);
    const usingEphemeralProductionPath = IS_PROD
      && !process.env.DB_PATH
      && !process.env.DATA_DIR
      && !process.env.RAILWAY_VOLUME_MOUNT_PATH;

    const findings = [];
    if (userVersion === 0 && !migrationTable) {
      findings.push({ severity: 'high', code: 'NO_SCHEMA_VERSION', message: 'No SQLite user_version or migration ledger is present.' });
    }
    if (usingEphemeralProductionPath) {
      findings.push({ severity: 'critical', code: 'EPHEMERAL_PRODUCTION_PATH', message: 'Production storage is not pinned to an explicit persistent path.' });
    }
    if (!envConfigured('BACKUP_S3_BUCKET')) {
      findings.push({ severity: 'high', code: 'NO_OFFSITE_BACKUP_SIGNAL', message: 'No offsite backup bucket is configured in this process environment.' });
    }
    if (!envConfigured('BACKUP_ENCRYPTION_KEY')) {
      findings.push({ severity: 'high', code: 'BACKUP_ENCRYPTION_KEY_MISSING', message: 'Encrypted offsite backup requires BACKUP_ENCRYPTION_KEY.' });
    }
    if (tables.some((table) => table.sensitiveColumns.length > 0)) {
      findings.push({ severity: 'high', code: 'SENSITIVE_COLUMNS_PRESENT', message: 'Sensitive-data candidate columns exist; verify field-level encryption and retention per table.' });
    }
    if (tables.reduce((sum, table) => sum + table.foreignKeyCount, 0) > 0
        && tables.reduce((sum, table) => sum + table.cascadeDeleteForeignKeys, 0) === 0) {
      findings.push({ severity: 'medium', code: 'NO_CASCADE_DELETE_RULES', message: 'Foreign keys exist but no ON DELETE CASCADE rules are defined; deletion relies on application code.' });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'read_only_schema_audit',
      database: {
        path: dbPath,
        dataDirectory: resolvedDataDir,
        bytes: fs.statSync(dbPath).size,
        journalMode,
        userVersion,
        migrationTable: migrationTable || null,
        integrityOk: integrity.length === 1 && integrity[0].integrity_check === 'ok',
        foreignKeyViolationCount: foreignKeyViolations.length,
      },
      backupConfiguration: {
        localDirectoryConfigured: envConfigured('BACKUP_DIR'),
        offsiteBucketConfigured: envConfigured('BACKUP_S3_BUCKET'),
        offsiteEndpointConfigured: envConfigured('BACKUP_S3_ENDPOINT'),
        applicationEncryptionImplemented: true,
        encryptionKeyConfigured: envConfigured('BACKUP_ENCRYPTION_KEY'),
      },
      tables,
      findings,
    };

    if (jsonOnly) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('Mentally Prepare storage audit (read only)');
      console.log(`Database: ${dbPath}`);
      console.log(`Integrity: ${report.database.integrityOk ? 'ok' : 'FAILED'}`);
      console.log(`Foreign-key violations: ${report.database.foreignKeyViolationCount}`);
      console.log(`Schema version: ${userVersion}; migration ledger: ${migrationTable || 'none'}`);
      console.log(`Tables: ${tables.length}; sensitive-data candidates: ${tables.filter((table) => table.sensitiveColumns.length).length} tables`);
      console.log('Findings:');
      for (const finding of findings) {
        console.log(`- [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`);
      }
      console.log('\nUse --json for machine-readable output. Row counts are omitted unless --include-counts is supplied.');
    }

    if (!report.database.integrityOk || report.database.foreignKeyViolationCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
