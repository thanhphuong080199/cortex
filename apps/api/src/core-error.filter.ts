import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";

const KINDS = new Set(["not_found", "conflict", "validation", "internal"]);
const isCoreError = (e: unknown): e is { kind: string; cause?: unknown; message?: string } =>
  typeof e === "object" && e !== null && KINDS.has((e as { kind?: string }).kind ?? "");

// Translates packages/core's CoreError into HTTP. not_found is deliberately returned
// for foreign rows too -- a 403 would confirm the row exists (spec §6).
@Catch()
export class CoreErrorFilter implements ExceptionFilter {
  private logger = new Logger("CoreErrorFilter");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (isCoreError(exception)) {
      if (exception.kind === "not_found") return res.status(404).json({ message: "Not found" });
      // CoreError.message is caller-facing by contract (errors.ts) -- PostgREST detail
      // stays in `cause`, which is never echoed.
      if (exception.kind === "conflict")
        return res.status(409).json({ message: exception.message ?? "Conflict" });
      if (exception.kind === "validation")
        return res.status(400).json({ message: exception.message ?? "Validation failed" });
      this.logger.error(JSON.stringify(exception.cause)); // logged, never echoed (spec §6)
      return res.status(500).json({ message: "Internal error" });
    }
    if (exception instanceof HttpException) {
      return res.status(exception.getStatus()).json(exception.getResponse());
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ message: "Internal error" });
  }
}
