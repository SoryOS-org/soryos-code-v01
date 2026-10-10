import { inngest } from "../client";
import { updateSessionStatus, addMessage } from "../middleware";
import { Template } from "@/config";
import { Id } from "@/convex/_generated/dataModel";
import { runProviderAgent } from "@/lib/providers/engine";

/**
 * Runs the native multi-provider agent loop (OpenRouter / Mistral / Gemini)
 * entirely inside the Next.js backend without a CLI inside the sandbox.
 *
 * Keep this in sync with `run-agent.ts` (the legacy CLI engine): session
 * status transitions, onFailure messaging and GitHub auto-push behave the same
 * so the existing mobile/web chat UI works unchanged.
 */
export const runAgentProvider = inngest.createFunction(
  {
    id: "run-agent-provider",
    retries: 0,
    concurrency: 25,
    onFailure: async ({ error, event }) => {
      console.log('🔴 RUN AGENT PROVIDER FAILURE HANDLER:', error?.message);

      const { sessionId } = event.data as unknown as { sessionId: string };

      try {
        const sessionIdAsId = sessionId as Id<"sessions">;
        const errorMessage = error?.message || String(error);
        const isTimeout = errorMessage.includes('FUNCTION_INVOCATION_TIMEOUT') ||
                          errorMessage.includes('timeout') ||
                          errorMessage.includes('Timeout') ||
                          errorMessage.includes('timed out') ||
                          errorMessage.includes('ETIMEDOUT') ||
                          errorMessage.includes('deadline exceeded');

        const isSandboxTerminated = errorMessage.includes('terminated') ||
                                    errorMessage.includes('[unknown]') ||
                                    errorMessage.includes('SandboxError') ||
                                    errorMessage.includes('unavailable') ||
                                    errorMessage.includes('sandbox not found');

        const isAborted = errorMessage.includes('aborted') ||
                          errorMessage.includes('Agent stopped by user');

        await updateSessionStatus(sessionIdAsId, "RUNNING");

        if (isAborted) {
          await addMessage(sessionIdAsId, "🛑 **Stopped**\n\nThe agent was stopped. Send a new message to continue.", "assistant");
        } else if (isTimeout) {
          const timeoutMessage = `⏱️ **Request Timed Out**\n\nThe AI took too long to respond. This can happen with complex tasks.\n\n**To continue:**\n• Send a new message to resume where we left off\n• Try breaking your request into smaller steps\n• Type "continue" to pick up from here\n\nYour progress has been saved.`;
          await addMessage(sessionIdAsId, timeoutMessage, "assistant");
        } else if (isSandboxTerminated) {
          const sandboxMessage = `🔄 **Session Interrupted**\n\nThe development environment was temporarily unavailable. This can happen due to server maintenance or high demand.\n\n**To continue:**\n• Send a new message and I'll pick up where we left off\n• Your code and progress have been saved\n• Type "continue" to resume\n\nIf this keeps happening, try starting a new session.`;
          await addMessage(sessionIdAsId, sandboxMessage, "assistant");
        } else {
          await addMessage(sessionIdAsId, `⚠️ **Agent error**\n\n${errorMessage.slice(0, 500)}`, "assistant");
        }
      } catch (failureError) {
        console.error('Failed to handle onFailure:', failureError);
      }
    },
  },
  { event: "vibracode/run.agent.provider" },
  async ({ event, step }) => {
    const { sessionId, id, message, template, model, sandboxId } = event.data as {
      sessionId: string;
      id: Id<"sessions">;
      message: string;
      template?: Template;
      model?: string;
      sandboxId: string;
    };

    await step.run("run provider agent", async () => {
      await runProviderAgent({ id, sandboxId, message, template, model });
    });
  }
);