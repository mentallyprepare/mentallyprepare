const path = require('path');
const IS_PROD = process.env.NODE_ENV === 'production';
const getDBPath = () => process.env.DB_PATH
  || path.join(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || (IS_PROD ? '/data/db' : path.join(__dirname, '..')), 'mentally-prepare.db');
const getBackupDir = () => process.env.BACKUP_DIR || path.join(path.dirname(getDBPath()), 'backups');
module.exports = { getDBPath, getBackupDir };
