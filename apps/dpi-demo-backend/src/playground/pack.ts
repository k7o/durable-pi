// The demo pack: the shared workspace document, todos, the durable jobs, the pager, session spawning and the
// playground prompt. This is the one file the demo app adds to the device; deleting the app leaves the device a bare
// device.
//
// The App State database is the device's (`app-state.sqlite`, the path `GET /v1/device` publishes): this pack only seeds
// the keys it owns (`goal`, `counter`, `notes`) and reads and changes the document through the store the device hands
// it. The pack owns the conversation documents a session seeds in order (Workspace, JobRuns, Todos), the two custom
// extensions, the three `/demo` routes and the device info the demo adds (`jobs`, the demo capability).
import { Router, type NextFunction, type Request, type Response } from "express";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  DEVICE_CAPABILITIES,
  invalid,
  type AppStateStore,
  type Device,
  type ConversationDoc,
  type DevicePack,
  type PackExtension,
  type PackSession,
  type SpawnSession,
} from "../../../dpi-backend/src/pack-api.js";
import type { AppState } from "../../../dpi-sdk/src/app-state.js";
import { JOB_RUNS_DOC } from "../../../dpi-sdk/src/packs/demo-jobs.js";
import { TODOS_DOC } from "../../../dpi-sdk/src/packs/demo-todos.js";
import { ADDON_INFO, PromptChecklist, PROMPTS, createAddons } from "./addons.js";
import { DemoEndpoints } from "./demo.js";
import { WORKSPACE_DOC, Workspace } from "./features/app-state/doc.js";
import { JOB_DEFS, jobDef } from "./features/jobs/defs.js";
import { createJobs, type Jobs } from "./features/jobs/engine.js";
import { JobRuns } from "./features/jobs/record.js";
import { Todos } from "./features/todos/doc.js";
import { fauxModels } from "../faux.js";
import { createPlayground } from "./playground.js";

const SEED: AppState = { goal: "Explore durable agents", counter: 0, notes: [] };

/** The demo pack, plus the use cases and state its routes and its tests share. */
export interface DemoPack extends DevicePack {
  readonly endpoints: DemoEndpoints;
  /** The device's App State store, as handed to `open`. The device opens and closes it. */
  shared(): AppStateStore;
  open(deps: { dataDir: string; appState: AppStateStore; notify: () => void }): Promise<void>;
  close(): Promise<void>;
}

export function createDemoPack(options: { offline: boolean }): DemoPack {
  let shared: AppStateStore | undefined;
  const jobsBySession = new Map<string, Jobs>();
  const addons = createAddons(options);
  const requireShared = () => {
    if (!shared) throw Error("The demo pack is not open. Device.open calls pack.open before any session.");
    return shared;
  };
  const endpoints = new DemoEndpoints(requireShared, (sessionId) => jobsBySession.get(sessionId));

  /** Seeding order is contract: Workspace, JobRuns, Todos. Do not reorder while moving. */
  const docs: readonly ConversationDoc[] = [
    { kind: WORKSPACE_DOC, empty: {}, seed: (tx, id) => tx.doc(Workspace, id), read: (h, id) => h.snapshot(Workspace, id, ctx) },
    {
      kind: JOB_RUNS_DOC,
      empty: { counts: {}, items: {} },
      seed: (tx, id) => tx.doc(JobRuns, id),
      read: (h, id) => h.snapshot(JobRuns, id, ctx),
    },
    { kind: TODOS_DOC, empty: { items: [] }, seed: (tx, id) => tx.doc(Todos, id), read: (h, id) => h.snapshot(Todos, id, ctx) },
  ];

  const sessionExtensions: PackExtension[] = ADDON_INFO.map((info) => ({
    ...info,
    extension: addons.all[info.name],
    ...(info.name === "system-prompts" ? { prompts: PROMPTS } : {}),
  }));

  const routes = (device: Device) => {
    const router = Router();
    const run = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
      void fn(req, res).catch(next);
    const agent = (req: Request) => device.resolveAgent(String(req.params.s), String(req.params.a));
    const taskId = (req: Request) => {
      const id = Number(req.params.taskId);
      if (!Number.isSafeInteger(id)) throw invalid("taskId must be an integer");
      return id;
    };

    router.post(
      "/sessions/:s/agents/:a/demo/state",
      run(async (req, res) => {
        const { c } = await agent(req);
        res.json(await endpoints.demoState(device, c, req.body ?? {}));
      }),
    );
    router.post(
      "/sessions/:s/agents/:a/demo/jobs",
      run(async (req, res) => {
        const { row, c } = await agent(req);
        res.status(201).json(await endpoints.startJob(device, row.id, c, req.body ?? {}));
      }),
    );
    router.post(
      "/sessions/:s/agents/:a/demo/jobs/:taskId/approval",
      run(async (req, res) => {
        const { c } = await agent(req);
        res.json(await endpoints.approveJob(c, taskId(req), req.body?.approved));
      }),
    );
    return router;
  };

  return {
    name: "demo",
    docs,
    endpoints,
    shared: requireShared,
    async open({ appState, notify }) {
      // The device opened the store and wakes its own change feed; the pack only contributes the keys it owns, and
      // `seed` leaves a key that already exists alone so a restart does not reset the demo's state.
      shared = appState;
      await shared.seed(SEED);
      notify();
    },
    async close() {
      // App State belongs to the device; closing it here would break the next pack that opens.
      shared = undefined;
      jobsBySession.clear();
    },
    createSession({ spawn }: { spawn: SpawnSession; appState: AppStateStore }): PackSession {
      return {
        install: ({ sessionId }) => {
          const jobs = createJobs({ shared: requireShared(), sessionId, todos: Todos });
          jobsBySession.set(sessionId, jobs);
          return [createPlayground(sessionId, spawn, jobs)];
        },
      };
    },
    // The free deterministic model: `DPI_PROVIDER=faux` is the demo app's, and the device asks the pack for it.
    models: () => fauxModels(),
    sessionExtensions: {
      list: sessionExtensions,
      prompts: async (h, conversationId) =>
        (await h.snapshot(PromptChecklist, conversationId, ctx))?.enabled ?? [PROMPTS[0].id],
      async setPrompt(c, id, enabled) {
        if (!PROMPTS.some((p) => p.id === id))
          throw invalid(`Unknown prompt ${id}. Known: ${PROMPTS.map((p) => p.id).join(", ")}`);
        await c.commit(async (tx) => {
          const doc = await tx.doc(PromptChecklist, c.id);
          const next = new Set(doc.enabled);
          if (enabled) next.add(id);
          else next.delete(id);
          doc.enabled = PROMPTS.map((p) => p.id).filter((provider) => next.has(provider));
        }, ctx);
      },
    },
    routes,
    info: () => ({ capabilities: [...DEVICE_CAPABILITIES, "demo", "jobs"], jobs: JOB_DEFS }),
    async labelTask(task, h) {
      if (!task.kind.startsWith("demo.job.")) return undefined;
      const run = (await h.snapshot(JobRuns, task.conversationId as ConversationId, ctx))?.items[String(task.id)];
      const def = jobDef(task.kind.slice("demo.job.".length));
      return def ? { label: run ? `${def.title} #${run.run}` : def.title } : undefined;
    },
  };
}
