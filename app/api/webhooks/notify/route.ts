// app/api/webhooks/notify/route.ts
//
// Called by the Hasura Event Trigger `deliver_notification` (see
// hasura/metadata/databases/default/tables/public_notification_events.yaml)
// whenever the execution engine inserts a notification_events row for a
// `notify` step. This keeps notify genuinely event-driven: the engine never
// calls Slack/email directly, it just writes a row and Hasura's event
// delivery (with its own retry_conf) invokes this handler.
//
// SLACK_WEBHOOK_URL: if set, posts a real Slack message. Otherwise runs in
// stub mode — logs the payload and marks the row delivered after a short
// delay, structured so adding a real webhook URL requires no code change.

import { NextRequest } from "next/server";
import { assertActionSecret, UnauthorizedError } from "@/lib/actionAuth";
import { adminGraphQL } from "@/lib/hasura";

interface HasuraEventPayload {
  event: {
    op: "INSERT" | "UPDATE" | "DELETE";
    data: { new: Record<string, unknown> | null };
  };
}

export async function POST(req: NextRequest) {
  try {
    assertActionSecret(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ message: e.message }, { status: 401 });
    throw e;
  }

  const body = (await req.json()) as HasuraEventPayload;
  const row = body.event.data.new;
  if (!row) return Response.json({ ok: true });

  const id = row.id as string;
  const channel = (row.channel as string) || "stub";
  const payload = row.payload as { message?: string };

  const slackWebhook = process.env.SLACK_WEBHOOK_URL;

  if (channel === "slack" && slackWebhook) {
    await fetch(slackWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: payload.message || "Workflow notification" }),
    });
  } else {
    // Stub mode: preserves the event-driven architecture without a real
    // delivery integration. Swap in SLACK_WEBHOOK_URL (or an email
    // provider call here) with no changes to the engine or schema.
    console.log(`[notify:stub] channel=${channel} payload=`, payload);
  }

  await adminGraphQL(
    `mutation($id: uuid!, $now: timestamptz!) {
      update_notification_events_by_pk(pk_columns: { id: $id }, _set: { delivered: true, delivered_at: $now }) { id }
    }`,
    { id, now: new Date().toISOString() }
  );

  return Response.json({ ok: true });
}
