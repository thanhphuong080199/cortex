import { Controller, Get, INestApplication, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentUser, currentUserFactory } from "../src/auth/current-user.decorator";
import type { AuthedUser } from "../src/auth/supabase-auth.guard";

describe("currentUserFactory (unit)", () => {
  it("returns req.user when SupabaseAuthGuard has set it", () => {
    const user: AuthedUser = { id: "u1", email: "a@b.com", token: "t" };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;

    expect(currentUserFactory(undefined, ctx)).toBe(user);
  });

  it("throws UnauthorizedException instead of returning undefined when req.user is missing", () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    expect(() => currentUserFactory(undefined, ctx)).toThrow(UnauthorizedException);
  });
});

// Ephemeral test-only controller (not part of AppModule): proves that a real route
// using @CurrentUser() without @UseGuards(SupabaseAuthGuard) fails closed with a clean
// 401 through Nest's actual HTTP + exception-filter pipeline, rather than crashing with
// an uncaught TypeError deep in the handler.
@Controller("unguarded-current-user")
class UnguardedCurrentUserController {
  @Get()
  get(@CurrentUser() user: AuthedUser) {
    return { id: user.id };
  }
}

describe("@CurrentUser() on a route with no SupabaseAuthGuard", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [UnguardedCurrentUserController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("responds 401 instead of throwing an uncaught TypeError", async () => {
    const res = await request(app.getHttpServer()).get("/unguarded-current-user");
    expect(res.status).toBe(401);
  });
});
