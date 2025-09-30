-- CreateTable
CREATE TABLE "DeviceSchedule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" TEXT,
    "windowStart" INTEGER NOT NULL,
    "windowEnd" INTEGER NOT NULL,
    "sceneCmd" TEXT NOT NULL DEFAULT 'SCENE 1',
    "offMode" TEXT NOT NULL DEFAULT 'OFF',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceSchedule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeviceSchedule_deviceId_enabled_idx" ON "DeviceSchedule"("deviceId", "enabled");

-- CreateIndex
CREATE INDEX "DeviceSchedule_priority_idx" ON "DeviceSchedule"("priority");
