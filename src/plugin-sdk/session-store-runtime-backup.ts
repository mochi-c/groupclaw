import path from "node:path";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { hasErrnoCode } from "../infra/errno.js";

/** Create a verified, standalone SQLite backup and preserve any legacy session index. */
export async function createSessionStoreBackup(params: {
  agentId?: string;
  storePath: string;
  backupDir: string;
}): Promise<void> {
  const fs = await import("node:fs/promises");
  const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
  const { captureBackupSqliteSourceGroup, planBackupSqliteSourceGroups } =
    await import("../infra/backup-sqlite-source-groups.js");
  const { embedSessionColdArchivesInSnapshot } =
    await import("../config/sessions/session-cold-storage-backup.js");
  const storePath = path.resolve(params.storePath);
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: params.agentId,
  }).path;

  await fs.mkdir(params.backupDir, { recursive: true, mode: 0o700 });
  for (const sourcePath of new Set([storePath, sqlitePath])) {
    const identity = await fs.stat(sourcePath, { bigint: true }).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!identity?.isFile()) {
      continue;
    }
    const targetPath = path.join(params.backupDir, path.basename(sourcePath));
    if (sourcePath !== sqlitePath) {
      await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      continue;
    }
    const physicalPath = await fs.realpath(sourcePath);
    const groups = await planBackupSqliteSourceGroups([{ path: physicalPath, identity }]);
    await captureBackupSqliteSourceGroup(groups.get(physicalPath)!, () =>
      createVerifiedSqliteSnapshot({
        sourcePath: physicalPath,
        targetPath,
        preserveRowIds: true,
        transform: (database) =>
          embedSessionColdArchivesInSnapshot({ database, sourceStorePath: storePath }),
      }),
    );
  }
}
