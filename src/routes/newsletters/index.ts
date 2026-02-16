import { Hono } from "hono";
import type { AuthVariables } from "../../middleware/auth";
import { crudRouter } from "./crud";
import { generateRouter } from "./generate";
import { publishRouter } from "./publish";
import { subscribersRouter } from "./subscribers";
import { versionsRouter } from "./versions";
import { aiBlocksRouter } from "./ai-blocks";

const newslettersRouter = new Hono<{ Variables: AuthVariables }>();

// Mount all sub-routers
// CRUD operations (list, create, get, update, delete)
newslettersRouter.route("/", crudRouter);

// AI generation (regenerate, generate-notes, preview, generate-notes-from-items)
newslettersRouter.route("/", generateRouter);

// AI block regeneration (regenerate-block)
newslettersRouter.route("/", aiBlocksRouter);

// Publishing and email sending (publish, send-email)
newslettersRouter.route("/", publishRouter);

// Subscriber management (list subscribers, delete subscriber)
newslettersRouter.route("/", subscribersRouter);

// Version history (list versions, get version, restore version)
newslettersRouter.route("/", versionsRouter);

export { newslettersRouter };
