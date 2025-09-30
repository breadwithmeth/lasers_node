-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "payload" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Event_device_id_idx" ON "Event"("device", "id");
