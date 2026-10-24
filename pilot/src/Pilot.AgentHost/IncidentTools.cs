using System.ComponentModel;

namespace Pilot.AgentHost;

/// <summary>
/// The tools the agent is offered. Each one declares whether it is safe to run again after a
/// crash; that classification is ours to make, not the engine's.
/// </summary>
internal static class IncidentTools
{
    public const string ReadLogsName = "read_logs";
    public const string ApplyFixName = "apply_fix";

    [Description("Read the production log stream and return matching entries.")]
    public static string ReadLogs(
        [Description("How far back to read, such as 5m or 1h.")] string since)
    {
        // Read-only, therefore replay-safe: a rerun produces the same answer.
        return $"""
            [{since}] checkout-api revision 4f2a1c
            2026-10-24T11:45:01Z ERROR guest-checkout 500 NullReferenceException at CheckoutApi.Probe
            2026-10-24T11:45:02Z ERROR guest-checkout 500 NullReferenceException at CheckoutApi.Probe
            2026-10-24T11:45:04Z WARN  checkout-api peak latency 4200ms
            """;
    }

    [Description("Apply the prepared fix on a branch and return the commit id.")]
    public static string ApplyFix(
        [Description("One-line description of the change.")] string change)
    {
        // Writes to the outside world, therefore NOT replay-safe on its own: it carries a
        // run-scoped marker so a replayed call does not commit twice.
        string directory = Path.Combine(Path.GetTempPath(), "pilot-fix");
        Directory.CreateDirectory(directory);
        string marker = Path.Combine(directory, "fix.done");

        if (File.Exists(marker))
        {
            return $"already applied: {File.ReadAllText(marker)}";
        }

        // The window to kill the host inside a tool call.
        Thread.Sleep(TimeSpan.FromSeconds(3));
        string commit = $"commit-{Guid.NewGuid().ToString("N")[..8]}";
        File.WriteAllText(marker, commit);
        return $"{commit} ({change})";
    }
}
