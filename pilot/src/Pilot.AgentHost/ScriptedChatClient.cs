using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Pilot.AgentHost;

/// <summary>
/// A deterministic stand-in for a model that issues real tool calls, so the harness tool loop is
/// exercised without credentials. It decides from the transcript, so a replay produces the same
/// script.
/// </summary>
internal sealed class ScriptedChatClient : IChatClient
{
    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        List<ChatMessage> transcript = [.. messages];
        return Task.FromResult(new ChatResponse(Next(transcript)));
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ChatMessage next = Next([.. messages]);

        // Streaming is only used for the final answer; a tool call is emitted whole.
        foreach (AIContent content in next.Contents)
        {
            await Task.Yield();
            cancellationToken.ThrowIfCancellationRequested();
            yield return new ChatResponseUpdate(ChatRole.Assistant, [content]);
        }
    }

    private static ChatMessage Next(List<ChatMessage> transcript)
    {
        List<string> calledTools = [.. transcript
            .SelectMany(m => m.Contents)
            .OfType<FunctionCallContent>()
            .Select(call => call.Name)];

        List<string> results = [.. transcript
            .SelectMany(m => m.Contents)
            .OfType<FunctionResultContent>()
            .Select(result => result.Result?.ToString() ?? string.Empty)];

        if (!calledTools.Contains(IncidentTools.ReadLogsName))
        {
            return Call(IncidentTools.ReadLogsName, new Dictionary<string, object?>
            {
                ["since"] = "5m",
            });
        }

        if (!calledTools.Contains(IncidentTools.ApplyFixName))
        {
            string log = results.FirstOrDefault() ?? string.Empty;
            return Call(IncidentTools.ApplyFixName, new Dictionary<string, object?>
            {
                ["change"] = $"guard the null probe; evidence: {FirstError(log)}",
            });
        }

        string fix = results.LastOrDefault() ?? "(no tool result)";
        return new ChatMessage(ChatRole.Assistant,
            $"""
            Root cause: null probe in guest checkout after revision 4f2a1c.
            Fix applied on a branch ({fix}).
            Impact: all guest carts; verified the failing test now passes.
            Ready for deploy approval.
            """);
    }

    private static string FirstError(string log) =>
        log.Split('\n').FirstOrDefault(line => line.Contains("ERROR", StringComparison.Ordinal))?.Trim()
        ?? "no error line";

    private static ChatMessage Call(string name, Dictionary<string, object?> arguments) =>
        new(ChatRole.Assistant, [new FunctionCallContent($"call-{name}", name, arguments)]);

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType == typeof(IChatClient) ? this : null;

    public void Dispose()
    {
    }
}
