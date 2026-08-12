// lib/actionAuth.ts
//
// Every Hasura Action request includes a `session_variables` object built
// by Hasura from the caller's JWT (X-Hasura-User-Id etc.) — this is how the
// Action handler learns "who is calling" without re-verifying a JWT itself.
// Hasura only forwards this to *your configured handler URL*, and we
// additionally require a shared `x-action-secret` header (set in
// hasura/metadata/actions.yaml) so the handler route can't be invoked by
// an arbitrary internet client pretending to be Hasura.

import { NextRequest } from "next/server";

export interface ActionSessionVariables {
  "x-hasura-user-id"?: string;
  "x-hasura-role"?: string;
  [key: string]: string | undefined;
}

export interface ActionRequestBody<TInput = Record<string, unknown>> {
  action: { name: string };
  input: TInput;
  session_variables: ActionSessionVariables;
  request_query?: string;
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
  }
}

export function assertActionSecret(req: NextRequest) {
  const expected = process.env.ACTION_SECRET;
  const got = req.headers.get("x-action-secret");
  if (!expected || got !== expected) {
    throw new UnauthorizedError("Invalid or missing action secret");
  }
}

export function getCallerUserId<TInput = Record<string, unknown>>(body: ActionRequestBody<TInput>): string {
  const userId = body.session_variables["x-hasura-user-id"];
  if (!userId) {
    throw new UnauthorizedError("Missing X-Hasura-User-Id — caller is not authenticated");
  }
  return userId;
}

export function actionError(message: string, status = 400) {
  return Response.json({ message }, { status });
}
