import { z } from "zod";

// .strict() rejects any key this schema doesn't define -- e.g. a body-supplied userId -- with a
// 400 instead of silently dropping it. That distinction is load-bearing: POST /search's
// isolation depends on p_user_id coming ONLY from the verified JWT, never from the request
// body, so a client that thinks it's supplying a user id must find out immediately, not have
// the field quietly ignored while the request still succeeds.
export const searchInput = z
  .object({
    q: z.string().trim().min(1).max(500),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
export type SearchInput = z.infer<typeof searchInput>;
