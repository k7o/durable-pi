using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.DurableTask;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.DurableTask.Client.AzureManaged;
using Microsoft.DurableTask.Worker;
using Microsoft.DurableTask.Worker.AzureManaged;
using Microsoft.Extensions.AI;
using Pilot.AgentHost;

const string AgentName = "Incident";
const string OrchestratorName = "IncidentRun";
const string DeployActivityName = "Deploy";
const string ApprovalEventName = "DeployApproval";

string dtsConnectionString =
    Environment.GetEnvironmentVariable("DURABLE_TASK_SCHEDULER_CONNECTION_STRING")
    ?? "Endpoint=http://localhost:8080;TaskHub=default;Authentication=None";

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// The model is behind IChatClient. The default is scripted so the failure tests run with no
// credentials; point Pilot__ChatClient at a real client to demo with a live model.
AIAgent agent = new ScriptedChatClient().AsAIAgent(
    instructions: "You are an incident agent. Investigate, fix, then wait for a human before deploying.",
    name: AgentName);

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
