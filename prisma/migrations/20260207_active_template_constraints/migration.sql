CREATE UNIQUE INDEX IF NOT EXISTS "Template_streamId_one_active"
ON "Template" ("streamId")
WHERE "isActive" = true AND "deletedAt" IS NULL AND "streamId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "LinkedStreamTemplate_linkedStreamId_one_active"
ON "LinkedStreamTemplate" ("linkedStreamId")
WHERE "isActive" = true AND "deletedAt" IS NULL;
