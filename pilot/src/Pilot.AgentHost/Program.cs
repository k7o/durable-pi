using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.DurableTask;
using DurableTask.Core.History;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.DurableTask.Client.AzureManaged;
using Microsoft.DurableTask.Worker;
using Microsoft.DurableTask.Worker.AzureManaged;
using Microsoft.Extensions.AI;
using Pilot.AgentHost;

const string AgentName = Names.Agent;
const string OrchestratorName = Names.Orchestrator;
const string DeployActivityName = Names.DeployActivity;
const string ApprovalEventName = Names.ApprovalEvent;

string dtsConnectionString =
    Environment.GetEnvironmentVariable("DURABLE_TASK_SCHEDULER_CONNECTION_STRING")
    ?? "Endpoint=http://localhost:8080;TaskHub=default;Authentication=None";

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// The model is behind IChatClient. The default is scripted so the failure tests run with no
// credentials; point Pilot__ChatClient at a real client to demo with a live model.
AITool[] incidentTools =
[
    AIFunctionFactory.Create(
        (string since) => IncidentTools.ReadLogs(since),
        name: IncidentTools.ReadLogsName,
        description: "Read the production log stream and return matching entries."),
    AIFunctionFactory.Create(
        (string change) => IncidentTools.ApplyFix(change),
        name: IncidentTools.ApplyFixName,
        description: "Apply the prepared fix on a branch and return the commit id."),
];

// The harness supplies todo state, compaction, tool approval and tracing around the same
// IChatClient. Everything it adds must survive serialization as part of the durable session.
#if PILOT_HARNESS
string defaultAgentKind = "harness";
#else
string defaultAgentKind = "plain";
#endif

// PILOT_AGENT=plain uses the bare chat client agent; anything else uses the harness.
string agentKind = (Environment.GetEnvironmentVariable("PILOT_AGENT") ?? defaultAgentKind).Trim();
bool withTools = (Environment.GetEnvironmentVariable("PILOT_TOOLS") ?? "1").Trim() != "0";

AITool[] tools = withTools ? incidentTools : [];

#if PILOT_HARNESS
AIAgent agent = agentKind.Equals("plain", StringComparison.OrdinalIgnoreCase)
    ? new ScriptedChatClient().AsAIAgent(
        instructions: "You are an incident agent. Investigate, fix, then wait for a human before deploying.",
        name: AgentName,
        tools: tools)
    : new ScriptedChatClient().AsHarnessAgent(HarnessOptions(tools));
#else
if (!agentKind.Equals("plain", StringComparison.OrdinalIgnoreCase))
{
    throw new InvalidOperationException(
        "The harness is compiled out. Build with -p:PilotHarness=true to reproduce the stall; "
        + "see pilot/FINDINGS.md. Use PILOT_AGENT=plain for the working configuration.");
}

AIAgent agent = new ScriptedChatClient().AsAIAgent(
    instructions: "You are an incident agent. Investigate, fix, then wait for a human before deploying.",
    name: AgentName,
    tools: tools);
#endif

builder.Services.ConfigureDurableAgents(
    options => options.AddAIAgent(agent, timeToLive: TimeSpan.FromHours(1)),
    workerBuilder: b =>
    {
        b.UseDurableTaskScheduler(dtsConnectionString);
        b.AddTasks(registry =>
        {
            registry.AddOrchestratorFunc<RunInput>(OrchestratorName, IncidentRunAsync);
            registry.AddActivityFunc<DeployInput, string>(DeployActivityName, DeployAsync);
        });
    },
    clientBuilder: b => b.UseDurableTaskScheduler(dtsConnectionString));

// The proactive half: the stream opens runs on its own. Off unless asked for.
if ((Environment.GetEnvironmentVariable("PILOT_TRIGGER") ?? "0").Trim() == "1")
{
    builder.Services.AddHostedService<LogStreamService>();
}

WebApplication app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { ok = true, agent = AgentName }));

// Admit a run. The instance id is derived from the client's key, so a repeat is a no-op.
app.MapPost("/runs", async (StartRunRequest request, DurableTaskClient client) =>
{
    if (string.IsNullOrWhiteSpace(request.RunKey))
    {
        return Results.BadRequest(new { error = "run_key is required" });
    }

    string runId = $"run-{request.RunKey}";
    OrchestrationMetadata? existing = await client.GetInstanceAsync(runId);
    if (existing is not null)
    {
        return Results.Ok(new { runId, created = false, state = existing.RuntimeStatus.ToString() });
    }

    await client.ScheduleNewOrchestrationInstanceAsync(
        OrchestratorName,
        new RunInput { RunKey = request.RunKey, Incident = request.Incident },
        new StartOrchestrationOptions { InstanceId = runId });

    return Results.Ok(new { runId, created = true, state = "Scheduled" });
});

// The watched stream and the code-side rule that decides an incident exists.
app.MapGet("/stream", (IServiceProvider services) =>
{
    LogStreamService? stream = services.GetServices<IHostedService>().OfType<LogStreamService>().FirstOrDefault();
    return stream is null
        ? Results.Ok(new { enabled = false, hint = "set PILOT_TRIGGER=1" })
        : Results.Ok(stream.Snapshot());
});

// Every run this device knows about, newest first. The hub in Durable Pi is a client of this.
app.MapGet("/runs", async (DurableTaskClient client) =>
{
    List<RunSummary> runs = [];
    await foreach (OrchestrationMetadata metadata in client.GetAllInstancesAsync(
        new OrchestrationQuery { PageSize = 100, FetchInputsAndOutputs = true }))
    {
        RunStatus? status = metadata.SerializedCustomStatus is null
            ? null
            : metadata.ReadCustomStatusAs<RunStatus>();

        runs.Add(new RunSummary(
            metadata.InstanceId,
            metadata.RuntimeStatus.ToString(),
            status?.Phase,
            metadata.CreatedAt));
    }

    return Results.Ok(runs.OrderByDescending(run => run.CreatedAt).Take(20));
});

app.MapDelete("/runs/{runId}", async (string runId, DurableTaskClient client) =>
{
    await client.PurgeInstanceAsync(runId);
    return Results.NoContent();
});

// Debug surface for the pilot: raw orchestration history, so a stalled run can be explained.
app.MapGet("/runs/{runId}/history", async (string runId, DurableTaskClient client) =>
{
    IList<HistoryEvent> history = await client.GetOrchestrationHistoryAsync(runId);
    return Results.Ok(history.Select(entry => new
    {
        type = entry.EventType.ToString(),
        name = entry switch
        {
            EventRaisedEvent raised => raised.Name,
            TaskScheduledEvent scheduled => scheduled.Name,
            ExecutionStartedEvent started => started.Name,
            _ => null,
        },
    }));
});

// Read a run. Safe to poll; it is the only source of truth a client gets.
app.MapGet("/runs/{runId}", async (string runId, DurableTaskClient client) =>
{
    OrchestrationMetadata? metadata = await client.GetInstanceAsync(runId, getInputsAndOutputs: true);
    if (metadata is null)
    {
        return Results.NotFound(new { error = "no such run" });
    }

    RunStatus? status = metadata.SerializedCustomStatus is null
        ? null
        : metadata.ReadCustomStatusAs<RunStatus>();

    return Results.Ok(new
    {
        runId,
        state = metadata.RuntimeStatus.ToString(),
        status,
        output = metadata.SerializedOutput,
    });
});

// Raise the approval the run is waiting on. A duplicate event for a settled phase is
// recorded in history and simply never consumed.
app.MapPost("/runs/{runId}/approvals", async (string runId, ApprovalRequest approval, DurableTaskClient client) =>
{
    OrchestrationMetadata? metadata = await client.GetInstanceAsync(runId);
    if (metadata is null)
    {
        return Results.NotFound(new { error = "no such run" });
    }

    await client.RaiseEventAsync(runId, ApprovalEventName, approval);
    return Results.Accepted($"/runs/{runId}");
});

// A thin watch surface over the same state. Reconnecting re-reads state, it does not replay a log.
app.MapGet("/runs/{runId}/events", async (string runId, DurableTaskClient client, HttpContext http, CancellationToken ct) =>
{
    http.Response.ContentType = "text/event-stream";

    string? lastFrame = null;
    while (!ct.IsCancellationRequested)
    {
        // Inputs and outputs must be requested for the custom status to come back at all.
        OrchestrationMetadata? metadata = await client.GetInstanceAsync(runId, getInputsAndOutputs: true, ct);
        if (metadata is null)
        {
            break;
        }

        string frame = JsonSerializer.Serialize(new
        {
            runId,
            state = metadata.RuntimeStatus.ToString(),
            status = metadata.SerializedCustomStatus,
        });

        if (frame != lastFrame)
        {
            lastFrame = frame;
            await http.Response.WriteAsync($"data: {frame}\n\n", ct);
            await http.Response.Body.FlushAsync(ct);
        }

        if (metadata.RuntimeStatus is OrchestrationRuntimeStatus.Completed
            or OrchestrationRuntimeStatus.Failed
            or OrchestrationRuntimeStatus.Terminated)
        {
            break;
        }

        await Task.Delay(TimeSpan.FromMilliseconds(500), ct);
    }
});

#if PILOT_HARNESS
// PILOT_DISABLE=filememory,todo,... switches harness capabilities off, so a stall can be
// bisected to the capability that causes it.
static HarnessAgentOptions HarnessOptions(AITool[] tools)
{
    string[] disabled = (Environment.GetEnvironmentVariable("PILOT_DISABLE") ?? string.Empty)
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    bool Off(string capability) => disabled.Contains(capability, StringComparer.OrdinalIgnoreCase);

    return new HarnessAgentOptions
    {
        Name = AgentName,
        HarnessInstructions = "You are an incident agent. Investigate, fix, then wait for a human before deploying.",
        ChatOptions = new ChatOptions { Tools = tools },
        MaximumIterationsPerRequest = 8,
        DisableFileMemory = Off("filememory"),
        DisableTodoProvider = Off("todo"),
        DisableAgentModeProvider = Off("mode"),
        DisableToolAutoApproval = Off("autoaproval"),
        DisableOpenTelemetry = Off("otel"),
        DisableCompaction = Off("compaction"),
        DisableWebSearch = Off("websearch"),
        DisableAgentSkillsProvider = Off("skills"),
    };
}
#endif

await app.RunAsync();

// The whole run is one orchestration, so every phase boundary is a checkpoint.
static async Task<object> IncidentRunAsync(TaskOrchestrationContext context, RunInput input)
{
    DurableAIAgent agent = context.GetAgent(AgentName);
    AgentSession session = await agent.CreateSessionAsync();

    // Phase: investigate
    context.SetCustomStatus(new RunStatus
    {
        Phase = "investigate",
        PhasesCompleted = [],
        Message = "Reading the log window",
    });

    AgentResponse response = await agent.RunAsync($"Investigate: {input.Incident}", session);

    // Phase: approve — a durable wait that consumes nothing while it waits.
    context.SetCustomStatus(new RunStatus
    {
        Phase = "approve",
        PhasesCompleted = ["investigate"],
        WaitingFor = ApprovalEventName,
        Message = "Fix is ready; waiting for a human to approve the deploy",
    });

    ApprovalRequest approval = await context.WaitForExternalEvent<ApprovalRequest>(
        eventName: ApprovalEventName,
        timeout: TimeSpan.FromHours(24));

    if (!approval.Approved)
    {
        context.SetCustomStatus(new RunStatus
        {
            Phase = "declined",
            PhasesCompleted = ["investigate", "approve"],
            Message = "Deploy declined by a human",
        });

        return new { input.RunKey, approved = false, feedback = approval.Feedback };
    }

    // Phase: deploy — the only phase that touches the outside world.
    context.SetCustomStatus(new RunStatus
    {
        Phase = "deploy",
        PhasesCompleted = ["investigate", "approve"],
        Message = "Rolling out the fix",
    });

    string deployed = await context.CallActivityAsync<string>(
        DeployActivityName,
        new DeployInput { RunKey = input.RunKey, Change = response.Text });

    context.SetCustomStatus(new RunStatus
    {
        Phase = "done",
        PhasesCompleted = ["investigate", "approve", "deploy"],
        Message = deployed,
    });

    return new
    {
        input.RunKey,
        approved = true,
        feedback = approval.Feedback,
        summary = response.Text,
        deploy = deployed,
    };
}

// An activity may run more than once. The marker file is the run-scoped idempotency key that
// makes "at least once" behave like "exactly once" for the side effect.
static string DeployAsync(TaskActivityContext context, DeployInput input)
{
    string directory = Path.Combine(Path.GetTempPath(), "pilot-deploy");
    Directory.CreateDirectory(directory);
    string marker = Path.Combine(directory, $"{input.RunKey}.done");

    if (File.Exists(marker))
    {
        return $"already deployed at {File.ReadAllText(marker)}";
    }

    // The window to kill the host in.
    Thread.Sleep(TimeSpan.FromSeconds(5));
    string stamp = DateTimeOffset.UtcNow.ToString("O");
    File.WriteAllText(marker, stamp);
    return $"deployed at {stamp}";
}
