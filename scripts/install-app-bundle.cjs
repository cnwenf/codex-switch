'use strict';

const defaultFs = require('node:fs');
const path = require('node:path');

const APP_BUNDLE_NAME = 'Codex Switch.app';
const STAGE_PREFIX = '.codex-switch-stage.';
const BACKUP_PREFIX = '.codex-switch-backup.';

function requireRealDirectory(fsImpl, target, label) {
  const stat = fsImpl.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function pathExists(fsImpl, target) {
  try {
    fsImpl.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function installAppBundle({ sourceApp, destination, physicalParent, fsImpl = defaultFs }) {
  if (![sourceApp, destination, physicalParent].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('app bundle paths must be absolute');
  }
  if ([sourceApp, destination, physicalParent].some((value) => /[\0\r\n]/.test(value))) {
    throw new Error('app bundle paths contain control characters');
  }
  if (fsImpl.realpathSync(physicalParent) !== physicalParent) {
    throw new Error('validated Applications parent identity changed');
  }
  requireRealDirectory(fsImpl, physicalParent, 'Applications parent');
  if (destination !== path.join(physicalParent, APP_BUNDLE_NAME)) {
    throw new Error('destination is outside the validated Applications parent');
  }
  if (path.basename(sourceApp) !== APP_BUNDLE_NAME) {
    throw new Error('source app name is invalid');
  }
  requireRealDirectory(fsImpl, sourceApp, 'source app');

  let stageRoot = null;
  let backup = null;
  let movedPrevious = false;
  let installed = false;
  try {
    stageRoot = fsImpl.mkdtempSync(path.join(physicalParent, STAGE_PREFIX));
    const stagedApp = path.join(stageRoot, APP_BUNDLE_NAME);
    fsImpl.cpSync(sourceApp, stagedApp, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    requireRealDirectory(fsImpl, stagedApp, 'staged app');

    backup = fsImpl.mkdtempSync(path.join(physicalParent, BACKUP_PREFIX));
    fsImpl.rmdirSync(backup);
    if (pathExists(fsImpl, destination)) {
      fsImpl.renameSync(destination, backup);
      movedPrevious = true;
    }

    try {
      fsImpl.renameSync(stagedApp, destination);
      installed = true;
    } catch (installError) {
      if (movedPrevious && !pathExists(fsImpl, destination)) {
        try {
          fsImpl.renameSync(backup, destination);
          movedPrevious = false;
        } catch (rollbackError) {
          const failure = new Error('app install failed and rollback could not complete; backup was preserved');
          failure.cause = installError;
          failure.rollbackCause = rollbackError;
          throw failure;
        }
      }
      throw installError;
    }

    if (movedPrevious) {
      fsImpl.rmSync(backup, { recursive: true, force: false });
      movedPrevious = false;
    }
  } finally {
    if (stageRoot && pathExists(fsImpl, stageRoot)) {
      fsImpl.rmSync(stageRoot, { recursive: true, force: true });
    }
    // A failed rollback deliberately leaves the uniquely named backup intact.
    // On success or a completed rollback, there is no backup path left to clean.
    if (!(movedPrevious && !installed) && backup && pathExists(fsImpl, backup)) {
      fsImpl.rmSync(backup, { recursive: true, force: false });
    }
  }
}

module.exports = { installAppBundle };

if (require.main === module) {
  if (process.argv.length !== 5) {
    process.stderr.write('[install] app bundle installer received invalid arguments\n');
    process.exitCode = 2;
  } else {
    try {
      installAppBundle({
        sourceApp: process.argv[2],
        destination: process.argv[3],
        physicalParent: process.argv[4],
      });
    } catch {
      process.stderr.write('[install] secure app bundle replacement failed\n');
      process.exitCode = 1;
    }
  }
}
