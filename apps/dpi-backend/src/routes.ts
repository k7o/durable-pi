// REST v1. Every route requires the device token (see auth.ts). Session refs are a UUID or a
// unique name; agent refs are a numeric id, `main`, or a unique name.
import { Router, type Request, type Response, type NextFunction } from "express";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { SessionRow, Device } from "./device.js";
import { agentStream, deviceStream, sessionStream } from "./streams.js";
import { idempotent } from "./idempotency.js";
import { invalid } from "./errors.js";

type Async = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Async) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

interface Locals {
  row: SessionRow;
  h: Harness;
  c: Conversation;
}

const param = (req: Request, key: string) => String(req.params[key]);
const int = (value: unknown, name: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw invalid(`${name} must be an integer`);
  return n;
};

export function v1(device: Device) {
  const r = Router();
  const create = idempotent(device);

  // Resolve :s and :a once per request.
  r.param("s", (req, res, next, value: string) => {
    try {
      const row = device.resolveSession(value);
      res.locals.row = row;
      next();
    } catch (e) {
      next(e);
    }
  });
  r.param("a", (req, res, next, value: string) => {
    device
      .resolveAgent(param(req, "s"), value)
      .then((resolved) => {
        Object.assign(res.locals, resolved);
        next();
      })
      .catch(next);
  });
  const L = (res: Response) => res.locals as Locals;

  // ---------------------------------------------------------- device
  r.get("/device", (_req, res) => res.json(device.deviceInfo()));
  r.get("/tree", route(async (_req, res) => res.json(await device.tree())));
  r.get("/events", (req, res, next) => {
    try {
      deviceStream(device, req, res);
    } catch (e) {
      next(e);
    }
  });
  r.get("/fs/dirs", route(async (req, res) => res.json(await device.browse(String(req.query.path ?? "")))));
  r.get(
    "/docs/:kind",
    route(async (req, res) => {
      const kind = param(req, "kind");
      if (!device.documents.deviceKinds.includes(kind)) throw invalid(`Unknown device document ${kind}`);
      res.json({ kind, ...(await device.deviceDoc(kind)) });
    }),
  );

  // ---------------------------------------------------------- sessions
  r.get("/sessions", route(async (_req, res) => res.json((await device.tree()).sessions)));
  r.post("/sessions", create, route(async (req, res) => res.status(201).json(await device.create(req.body ?? {}))));
  r.get("/sessions/:s", route(async (_req, res) => res.json(await device.sessionSummary(L(res).row))));
  r.patch("/sessions/:s", route(async (req, res) => res.json(await device.rename(L(res).row, req.body?.name))));
  r.get("/sessions/:s/compaction", route(async (_req, res) => res.json(device.compactionOf(L(res).row.id))));
  r.patch("/sessions/:s/compaction", route(async (req, res) => res.json(device.setCompaction(L(res).row, req.body ?? {}))));
  r.delete("/sessions/:s", route(async (_req, res) => res.json(await device.archive(L(res).row))));
  r.get("/sessions/:s/events", route(async (_req, res) => sessionStream(device, L(res).row, res)));
  r.get(
    "/sessions/:s/tasks",
    route(async (req, res) => {
      const status = String(req.query.status ?? "terminal");
      if (!["live", "terminal"].includes(status)) throw invalid("status must be live or terminal");
      const h = device.harness(L(res).row);
      if (status === "live") return res.json(await device.liveTasks(h));
      res.json(await device.tasks(h, status, Number(req.query.limit ?? 20)));
    }),
  );
  r.post(
    "/sessions/:s/tasks/:taskId/abort",
    route(async (req, res) => res.json(await device.abortTask(device.harness(L(res).row), int(req.params.taskId, "taskId")))),
  );
  r.get("/sessions/:s/inspect", route(async (_req, res) => res.json(await device.inspect(device.harness(L(res).row)))));
  r.get(
    "/sessions/:s/submissions/:id",
    route(async (req, res) => {
      const closed = new AbortController();
      res.on("close", () => closed.abort());
      res.json(
        await device.settled(
          device.harness(L(res).row),
          int(req.params.id, "submission id"),
          Math.min(Number(req.query.waitMs ?? 0) || 0, 300_000),
          closed.signal,
        ),
      );
    }),
  );

  // ---------------------------------------------------------- agents
  r.get("/sessions/:s/agents", route(async (_req, res) => res.json(await device.agents(L(res).row))));
  r.post(
    "/sessions/:s/agents",
    create,
    route(async (req, res) => res.status(201).json(await device.createAgent(L(res).row, req.body ?? {}))),
  );
  const a = "/sessions/:s/agents/:a";
  r.get(a, route(async (_req, res) => res.json(await device.agentDetail(L(res).row, L(res).c))));
  r.patch(
    a,
    route(async (req, res) => {
      device.setAgentName(L(res).row, L(res).c.id as number, req.body?.name);
      res.json(await device.agentSummary(L(res).row, L(res).c));
    }),
  );
  r.get(`${a}/events`, route(async (req, res) => agentStream(device, L(res), req, res)));
  r.get(
    `${a}/entries`,
    route(async (req, res) => {
      const scope = String(req.query.scope ?? "all");
      if (scope === "active") return res.json({ items: await device.activeEntries(L(res).c) });
      res.json(await device.entries(L(res).c, req.query.cursor as string | undefined, Number(req.query.limit ?? 500)));
    }),
  );
  r.get(`${a}/transcript`, route(async (req, res) => res.json(await device.transcript(L(res).c, String(req.query.format ?? "json")))));
  r.post(
    `${a}/messages`,
    route(async (req, res) => {
      const { h, c } = L(res);
      const submission = await device.send(c, req.body ?? {});
      const waitMs = Number(req.body?.waitMs ?? 0) || 0;
      if (!waitMs) return res.status(202).json({ submissionId: submission.id, status: "queued" });
      const closed = new AbortController();
      res.on("close", () => closed.abort());
      const result = await device.settled(h, submission.id as number, waitMs, closed.signal);
      res.status(result.status === "done" || result.status === "unanswered" ? 200 : 202).json(result);
    }),
  );
  r.delete(
    `${a}/inbox/:submissionId`,
    route(async (req, res) => res.json(await device.withdraw(L(res).h, L(res).c, int(req.params.submissionId, "submissionId")))),
  );
  r.post(`${a}/abort`, route(async (req, res) => res.json(await device.abort(L(res).c, req.body?.background === true))));
  r.post(`${a}/fork`, create, route(async (req, res) => res.status(201).json(await device.fork(L(res).row, L(res).c, req.body ?? {}))));
  r.get(`${a}/config`, route(async (_req, res) => res.json((await device.agentDetail(L(res).row, L(res).c)).config)));
  r.patch(`${a}/config`, route(async (req, res) => res.json(await device.configure(L(res).row, L(res).c, req.body ?? {}))));
  r.get(`${a}/extensions`, route(async (_req, res) => res.json(await device.extensionsOf(L(res).row, L(res).c))));
  r.patch(`${a}/extensions`, route(async (req, res) => res.json(await device.setExtension(L(res).row, L(res).c, req.body ?? {}))));
  r.post(`${a}/compact`, route(async (req, res) => res.json(await device.compact(L(res).c, req.body?.instructions))));
  r.post(`${a}/reset`, route(async (req, res) => res.json(await device.reset(L(res).c, req.body?.note))));
  r.get(
    `${a}/docs/:kind`,
    route(async (req, res) => {
      const kind = param(req, "kind");
      res.json({ kind, value: await device.agentDoc(L(res).h, L(res).c, kind) });
    }),
  );

  // ---------------------------------------------------------- the pack's own routes
  const extra = device.pack.routes?.(device);
  if (extra) r.use(extra);

  return r;
}
