# Glossary

The domain language for Durable Pi. Use these terms in code, tests, issues and design notes. The
terms describe the product, not its implementation.

## Device network

**Device** — one machine running a `dpi-backend`: it owns its sessions, agent databases, tools and
filesystem. Clients reach it by URL and bearer token. A network is a set of devices; nothing else
names a machine.

**Catalog** — a device's own record of itself: its sessions, agent names, device identity,
idempotency keys and per-session compaction thresholds. The catalog outlives any open session.

## Sessions and agents

**Session** — one harness and one agent database on a device. It has a name, a working directory and
a model. Clients create, rename and archive sessions; archiving moves the files aside and never
deletes them.

**Agent** — the client-facing identity of one conversation inside a session: the root (`Main`), a
fork, or a subagent. An agent has an id, name, kind and an owner when it is a subagent.

**Conversation** — the transcript scope an agent addresses, as pi-durable models it. Every agent
names exactly one conversation; the conversation is where entries, submissions and task ownership
actually live. Clients say *agent*; the harness says *conversation*.

**Entry** — one immutable transcript record in a conversation.

**Submission** — one admitted input to an agent. It is queued or pending until it settles into an
entry, and can be withdrawn before then.

**Turn** — one assistant response and the tool calls it makes. A **run** is the sequence of turns
from an admitted input to the final answer.

## Durable work

**Durable job** — a repeatable workflow with named phases, declared once and started by a person or
an agent. Each execution is a **run**.

**Run** — one execution of a durable job. A run is a pi-durable task, so its phases are checkpoints:
a restart resumes the current phase rather than repeating completed ones. A run records its phases,
steps, approval and result.

**Phase** — one named step of a run. A phase does work, records what it did, then commits the next
checkpoint. Some phases repeat; an approval phase waits for a person.

**Step** — one recorded action inside a phase: a command, a subagent tool call, an App State write
or a checkpoint.

## Shared state and extensions

**App State** — the JSON document every session and agent on a device can read and change. Changes
are revisioned, so a writer that started from a stale revision is refused.

**Extension** — an installed set of tools and behaviour that an agent may select. Built-in
extensions are always installed; custom ones are installed but off until an agent enables them.

**Tool** — one callable capability offered to a model. Each tool declares whether it is replay-safe.
Some tools only read; others create, update or delete.
