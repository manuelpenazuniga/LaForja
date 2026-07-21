-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pseudonym" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "discipline" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "license" TEXT NOT NULL DEFAULT 'unlicensed-ephemeral',
    "isTeamAuthored" BOOLEAN NOT NULL DEFAULT false,
    "publicationEligible" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Item_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Item_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ItemVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "stem" TEXT NOT NULL,
    "optionsJson" TEXT NOT NULL,
    "correctKey" TEXT NOT NULL,
    "authorRationale" TEXT NOT NULL,
    "diffJson" TEXT,
    "previousVersionId" TEXT,
    "immutable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ItemVersion_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "ItemVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GauntletRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "itemVersionId" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "evalBatchId" TEXT,
    "runIndex" INTEGER,
    "adjudicationState" TEXT,
    "compliance" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "GauntletRun_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GauntletRun_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemVersionId" TEXT NOT NULL,
    "gauntletRunId" TEXT,
    "reviewerType" TEXT NOT NULL,
    "verificationKind" TEXT NOT NULL,
    "checkClass" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "schemaValid" BOOLEAN NOT NULL DEFAULT false,
    "contractJson" TEXT NOT NULL,
    "invariantId" TEXT,
    "executorVersion" TEXT,
    "thresholdVersion" TEXT,
    "citationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Check_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Check_gauntletRunId_fkey" FOREIGN KEY ("gauntletRunId") REFERENCES "GauntletRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Check_citationId_fkey" FOREIGN KEY ("citationId") REFERENCES "Citation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Citation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "versionDate" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "relevance" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "HistoryRunBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemVersionId" TEXT NOT NULL,
    "expectedCheckCount" INTEGER NOT NULL,
    "completedCheckCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "blocksPublish" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "HistoryRunBatch_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoryReRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "itemVersionId" TEXT NOT NULL,
    "originalCheckId" TEXT NOT NULL,
    "checkClass" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "detailsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HistoryReRun_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HistoryRunBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HistoryReRun_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HistoryReRun_originalCheckId_fkey" FOREIGN KEY ("originalCheckId") REFERENCES "Check" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Defense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemVersionId" TEXT NOT NULL,
    "questionsJson" TEXT NOT NULL,
    "answersJson" TEXT,
    "rubricJson" TEXT,
    "totalScore" INTEGER,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Defense_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gauntletRunId" TEXT,
    "itemVersionId" TEXT,
    "defenseId" TEXT,
    "callSite" TEXT NOT NULL,
    "reviewerType" TEXT,
    "modelId" TEXT NOT NULL,
    "modelFamilyOk" BOOLEAN NOT NULL DEFAULT false,
    "promptVersion" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costUsd" REAL,
    "schemaValid" BOOLEAN NOT NULL DEFAULT false,
    "rawJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelCall_gauntletRunId_fkey" FOREIGN KEY ("gauntletRunId") REFERENCES "GauntletRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelCall_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelCall_defenseId_fkey" FOREIGN KEY ("defenseId") REFERENCES "Defense" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Passport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "itemVersionId" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Passport_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Passport_itemVersionId_fkey" FOREIGN KEY ("itemVersionId") REFERENCES "ItemVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Item_currentVersionId_key" ON "Item"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemVersion_itemId_versionNumber_key" ON "ItemVersion"("itemId", "versionNumber");

-- CreateIndex
CREATE INDEX "GauntletRun_itemVersionId_config_idx" ON "GauntletRun"("itemVersionId", "config");

-- CreateIndex
CREATE INDEX "GauntletRun_evalBatchId_idx" ON "GauntletRun"("evalBatchId");

-- CreateIndex
CREATE INDEX "Check_itemVersionId_status_idx" ON "Check"("itemVersionId", "status");

-- CreateIndex
CREATE INDEX "Check_gauntletRunId_idx" ON "Check"("gauntletRunId");

-- CreateIndex
CREATE INDEX "Check_invariantId_idx" ON "Check"("invariantId");

-- CreateIndex
CREATE INDEX "HistoryRunBatch_itemVersionId_status_idx" ON "HistoryRunBatch"("itemVersionId", "status");

-- CreateIndex
CREATE INDEX "HistoryReRun_originalCheckId_idx" ON "HistoryReRun"("originalCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryReRun_itemVersionId_originalCheckId_key" ON "HistoryReRun"("itemVersionId", "originalCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "Defense_itemVersionId_key" ON "Defense"("itemVersionId");

-- CreateIndex
CREATE INDEX "ModelCall_gauntletRunId_idx" ON "ModelCall"("gauntletRunId");

-- CreateIndex
CREATE INDEX "ModelCall_itemVersionId_idx" ON "ModelCall"("itemVersionId");

-- CreateIndex
CREATE INDEX "ModelCall_defenseId_idx" ON "ModelCall"("defenseId");

-- CreateIndex
CREATE UNIQUE INDEX "Passport_itemId_itemVersionId_key" ON "Passport"("itemId", "itemVersionId");

