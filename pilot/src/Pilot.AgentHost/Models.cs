using System.Text.Json.Serialization;

namespace Pilot.AgentHost;

/// <summary>What a client asks for. The run key is the idempotency key.</summary>
public sealed class StartRunRequest
{
    [JsonPropertyName("run_key")]
    public string RunKey { get; set; } = string.Empty;

    [JsonPropertyName("incident")]
    public string Incident { get; set; } = string.Empty;
}

/// <summary>Orchestration input. Immutable for the life of a run.</summary>
public sealed class RunInput
{
    [JsonPropertyName("run_key")]
    public string RunKey { get; set; } = string.Empty;

    [JsonPropertyName("incident")]
    public string Incident { get; set; } = string.Empty;
}

/// <summary>
/// The client-visible state of a run. Everything a client is allowed to know comes from
/// here; it is set by the orchestrator and persisted as custom status.
/// </summary>
public sealed record RunStatus
{
    [JsonPropertyName("phase")]
    public string Phase { get; init; } = "queued";

    [JsonPropertyName("phases_completed")]
    public IReadOnlyList<string> PhasesCompleted { get; init; } = [];

    [JsonPropertyName("waiting_for")]
    public string? WaitingFor { get; init; }

    [JsonPropertyName("message")]
    public string Message { get; init; } = string.Empty;
}

public sealed class ApprovalRequest
{
    [JsonPropertyName("approved")]
    public bool Approved { get; set; }

    [JsonPropertyName("feedback")]
    public string Feedback { get; set; } = string.Empty;
}

public sealed record DeployInput
{
    [JsonPropertyName("run_key")]
    public string RunKey { get; init; } = string.Empty;

    [JsonPropertyName("change")]
    public string Change { get; init; } = string.Empty;
}
