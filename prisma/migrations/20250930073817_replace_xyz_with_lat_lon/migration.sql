/*
  Warnings:

  - You are about to drop the column `x` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `y` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `z` on the `Device` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lat" REAL,
    "lon" REAL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Device" ("createdAt", "id", "lastSeenAt", "updatedAt") SELECT "createdAt", "id", "lastSeenAt", "updatedAt" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
