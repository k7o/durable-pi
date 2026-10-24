using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Pilot.AgentHost;

/// <summary>
/// A deterministic stand-in for a model, so the failure tests need no credentials and no
/// network. Each call answers from the message text, which keeps replays identical.
/// </summary>
internal sealed class ScriptedChatClient : IChatClient
{
    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        string prompt = messages.LastOrDefault()?.Text ?? string.Empty;
        return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, Answer(prompt))));
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        string answer = Answer(messages.LastOrDefault()?.Text ?? string.Empty);
        foreach (string word in answer.Split(' '))
        {
            await Task.Yield();
            cancellationToken.ThrowIfCancellationRequested();
            yield return new ChatResponseUpdate(ChatRole.Assistant, word + " ");
        }
    }

    private static string Answer(string prompt) => prompt switch
    {
        _ when prompt.Contains("Investigate", StringComparison.Ordinal) =>
            "guest checkout returns 500 since revision 4f2a1c; null pointer in CheckoutApi.Probe; "
            + "impact: all guest carts. Fix prepared on branch fix/checkout-probe.",
        _ when prompt.Contains("Approved", StringComparison.Ordinal) =>
            "deploy approved",
        _ => "no work to do",
    };

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType == typeof(IChatClient) ? this : null;

    public void Dispose()
    {
    }
}
