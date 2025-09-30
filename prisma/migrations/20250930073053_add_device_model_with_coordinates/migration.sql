-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "x" REAL,
    "y" REAL,
    "z" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    CONSTRAINT "Event_device_fkey" FOREIGN KEY ("device") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Event" ("device", "id", "payload", "ts") SELECT "device", "id", "payload", "ts" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE INDEX "Event_device_id_idx" ON "Event"("device", "id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
