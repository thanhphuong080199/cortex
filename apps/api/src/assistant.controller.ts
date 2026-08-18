import { randomUUID } from "node:crypto";
import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { AiClient } from "@cortex/core";
import {
  createServiceClient, createUserClient, declineOffer, errorMessage, recordUsage, runTurn,
} from "@cortex/core";
import { assistantInput, declineOfferInput, type AssistantInput, type DeclineOfferInput } from "@cortex/shared";
import { AI_CLIENT } from "./ai-client.provider";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthedUser } from "./auth/supabase-auth.guard";
import { SupabaseAuthGuard } from "./auth/supabase-auth.guard";
import { parseApiEnv } from "./env";
import { ZodValidationPipe } from "./zod-validation.pipe";

@Controller("assistant")
@UseGuards(SupabaseAuthGuard)
export class AssistantController {
  // Service-role, singleton, for search_notes and the ledger only. Every user-facing read and
  // write in the turn goes through createUserClient with the caller's JWT -- RLS is the
  // enforcement, per spec §11.
  private readonly serviceDb = createServiceClient();

  constructor(@Inject(AI_CLIENT) private readonly ai: AiClient) {}

  /**
   * Deliberately NOT an eager `private readonly env = parseApiEnv(process.env)` class field.
   * Nest instantiates every controller listed in a module's `controllers` array at
   * `app.init()` time -- including during every OTHER e2e suite's boot via
   * test/harness.ts's bootstrapTestApp(), which every e2e suite in this repo goes through. An
   * eager field initializer would run parseApiEnv (and its ZodError if
   * ASSISTANT_MONTHLY_BUDGET_USD is missing or invalid) at boot for all of them, not only for
   * a request that actually hits POST /assistant -- the exact trap ai-client.provider.ts's
   * createLazyGeminiAi documents and avoids for GEMINI_API_KEY/GEMINI_TIER. Parsing here,
   * inside the handler, defers it to request time; it is not cached the way
   * createLazyGeminiAi's real client is, because a zod parse of a handful of already-string
   * env vars is cheap enough per request not to need it.
   */
  private env() {
    return parseApiEnv(process.env);
  }

  // NestJS's RouterExecutionContext sets the response status to 201 (POST's default) BEFORE
  // the handler runs, independent of @Res() -- so without this override, a stream that never
  // calls res.status() itself gets flushed with 201 on its very first header write, and every
  // client of this SSE endpoint would see "Created" on what is actually a stream, not a
  // resource creation confirmation.
  @Post()
  @HttpCode(200)
  async assist(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(assistantInput)) body: AssistantInput,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const budgetUsd = this.env().ASSISTANT_MONTHLY_BUDGET_USD;

    // Diagnostic only, temporary: correlates with runTurn's own `[assistant:timing]` lines
    // (same clock, this controller's t0 is always <= runTurn's t0) so a slow turn can be told
    // apart from slow middleware (SupabaseAuthGuard, the zod body validation) ahead of it.
    const reqT0 = Date.now();
    console.log(`[assistant:timing] controller received POST /assistant, noteId=${body.noteId}`);

    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    // Closing the tab must actually stop the work. Without this the answer streams to
    // completion into a socket nobody is reading, and we pay for all of it.
    const abort = new AbortController();
    req.on("close", () => abort.abort());

    try {
      for await (const event of runTurn(
        { userDb: createUserClient(user.token), serviceDb: this.serviceDb, ai: this.ai },
        {
          userId: user.id,
          noteId: body.noteId,
          sessionId: body.sessionId,
          content: body.content,
          createdAt: body.createdAt,
          timeZone: body.timeZone,
          budgetUsd,
          signal: abort.signal,
        },
      )) {
        if (res.writableEnded) break;
        const { type, ...data } = event;
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      console.log(`[assistant:timing] controller stream done +${Date.now() - reqT0}ms since request received`);
    } catch (err) {
      // Headers are already sent, so there is no status code left to set -- the only way to
      // report a failure is inside the stream. Never the raw error: it can carry model output.
      console.error(`[assistant] turn failed: ${errorMessage(err)}`);
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "the turn failed" })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  // @HttpCode, like the streaming handler above it: Nest's RouterExecutionContext sets 201 on a
  // POST before the handler runs. A decline creates nothing the caller can address, so 204 is
  // the honest status -- and the web client keys on it.
  @Post("decline")
  @HttpCode(204)
  async decline(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(declineOfferInput)) body: DeclineOfferInput,
  ): Promise<void> {
    // The offer's own statement was never embedded server-side (turn.ts builds it from the
    // model's answer text, not from a retrieval call) -- embed it here, the same call retrieve()
    // makes for a query, so the stored row has the vector Task 14's dedup compares against.
    //
    // Metered like every other Gemini call on this branch (proposeOffer's classify and embed
    // calls in offer.ts, extractNote's classification, retrieve's query embedding) -- this used
    // to be the one call the cost circuit-breaker could not see (Finding 2, final whole-branch
    // review). A ledger-write failure must not turn a successful decline into a failed one, so
    // it is never fatal, the same trade offer.ts's own embed metering makes.
    const requestId = randomUUID();
    const { vectors, inputTokens, model } = await this.ai.embed([body.statement]);
    const embedding = vectors[0];
    if (!embedding) throw new Error("assistant: embed() returned no vector for the decline");

    try {
      await recordUsage(this.serviceDb, {
        userId: user.id, kind: "embed", model, inputTokens, outputTokens: 0,
        source: "assistant", requestId, contentChars: body.statement.length,
      });
    } catch (err) {
      console.error(`[assistant] decline embed ledger failed (request ${requestId}): ${errorMessage(err)}`);
    }

    await declineOffer(this.serviceDb, { userId: user.id, statement: body.statement, embedding });
  }
}
