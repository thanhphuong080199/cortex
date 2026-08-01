import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

// One schema definition serves both the API boundary and the web client
// (packages/shared/src/dto) -- they can never drift out of sync (spec §4.2).
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      // Field paths are echoed so the client can mark the offending input; the raw
      // zod error (which quotes received values back) is not.
      throw new BadRequestException({
        message: "validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}
