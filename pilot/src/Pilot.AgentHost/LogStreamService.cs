using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Pilot.AgentHost;

namespace Pilot.AgentHost;

/// <summary>
/// A stand-in production log stream plus the code-side rule that decides when an incident exists.
/// The threshold is deliberately not a model call: code owns thresholds and side effects, the
/// agent owns the open-ended work. When the rule fires, this service admits a run by itself.
/// </summary>
public sealed class LogStreamService : BackgroundService
{
    public const string Fingerprint = "CheckoutApi.Probe";

    private const int Threshold = 3;
    private static readonly TimeSpan Window = TimeSpan.FromSeconds(120);

    private readonly ILogger<LogStreamService> _logger;
    private readonly IServiceScopeFactory _scopes;
    private readonly Lock _gate = new();
    private readonly Queue<(DateTimeOffset At, string Line, bool IsIncident)> _recent = new();
    private readonly List<DateTimeOffset> _hits = [];
    private readonly List<string> _openedRunIds = [];
    private readonly int _faultAfter;
    private int _lineNumber;

    public LogStreamService(ILogger<LogStreamService> logger, IServiceScopeFactory scopes, IConfiguration configuration)
    {
        _logger = logger;
        _scopes = scopes;
        _faultAfter = int.TryParse(configuration["PILOT_TRIGGER_FAULT_AFTER"], out int after) ? after : 8;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(1200), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            string line = NextLine();
            bool isIncident = line.Contains(Fingerprint, StringComparison.Ordinal);

            lock (_gate)
            {
                _recent.Enqueue((DateTimeOffset.UtcNow, line, isIncident));
                while (_recent.Count > 50)
                {
                    _recent.Dequeue();
                }
            }

            if (isIncident)
            {
                await ConsiderOpeningIncidentAsync(line, stoppingToken);
            }
        }
    }

    /// <summary>Snapshot for the demo endpoint.</summary>
    public object Snapshot()
    {
        lock (_gate)
        {
            return new
            {
                fingerprint = Fingerprint,
                threshold = Threshold,
                windowSeconds = (int)Window.TotalSeconds,
                incidentLinesInWindow = _hits.Count,
                openedRunIds = _openedRunIds.ToArray(),
                recent = _recent.Select(entry => new
                {
                    at = entry.At.ToString("O"),
                    incident = entry.IsIncident,
                    line = entry.Line,
                }).ToArray(),
            };
        }
    }

    private async Task ConsiderOpeningIncidentAsync(string line, CancellationToken stoppingToken)
    {
        string? runKey = null;
        lock (_gate)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            _hits.RemoveAll(at => now - at > Window);
            _hits.Add(now);

            if (_hits.Count >= Threshold)
            {
                // Keyed by the window that tripped, so the same fault cannot open two runs.
                long windowStart = _hits[0].ToUnixTimeSeconds();
                runKey = $"incident-{Fingerprint}-{windowStart}";
            }
        }

        if (runKey is null)
        {
            return;
        }

        string runId = $"run-{runKey}";
        lock (_gate)
        {
            if (_openedRunIds.Contains(runId))
            {
                return;
            }
        }

        using IServiceScope scope = _scopes.CreateScope();
        DurableTaskClient client = scope.ServiceProvider.GetRequiredService<DurableTaskClient>();

        if (await client.GetInstanceAsync(runId, stoppingToken) is not null)
        {
            return;
        }

        await client.ScheduleNewOrchestrationInstanceAsync(
            Names.Orchestrator,
            new RunInput { RunKey = runKey, Incident = $"guest checkout failing: {line.Trim()}" },
            new StartOrchestrationOptions { InstanceId = runId },
            stoppingToken);

        lock (_gate)
        {
            _openedRunIds.Add(runId);
        }

        _logger.LogInformation("Opened incident {RunId} from the log stream without being asked", runId);
    }

    private string NextLine()
    {
        _lineNumber++;

        // A "bad deploy" lands, then the stream starts reporting it.
        if (_lineNumber <= _faultAfter)
        {
            return _lineNumber % 3 == 0
                ? "2026-10-24T12:00:00Z INFO  checkout-api guest-checkout 200 in 42ms"
                : "2026-10-24T12:00:00Z INFO  checkout-api member-checkout 200 in 51ms";
        }

        return "2026-10-24T12:00:01Z ERROR guest-checkout 500 NullReferenceException at CheckoutApi.Probe";
    }
}
