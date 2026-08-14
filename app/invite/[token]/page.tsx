"use client";

import { useState } from "react";
import { useMutation } from "@apollo/client";
import { useAuthenticationStatus } from "@nhost/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ACCEPT_INVITATION } from "@/lib/graphql/documents";

export default function AcceptInvitePage({ params }: { params: { token: string } }) {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const router = useRouter();
  const [acceptInvitation, { loading, error }] = useMutation(ACCEPT_INVITATION);
  const [result, setResult] = useState<{ status: string } | null>(null);

  if (isLoading) return <div className="container">Loading…</div>;

  if (!isAuthenticated) {
    return (
      <div className="container" style={{ maxWidth: 480 }}>
        <h1>You&apos;ve been invited</h1>
        <p className="card">
          Sign in or create an account with the email address this invite was sent to, then come back to this
          link to accept it.
        </p>
        <p>
          <Link href="/auth/sign-in">Sign in</Link> · <Link href="/auth/sign-up">Sign up</Link>
        </p>
      </div>
    );
  }

  async function onAccept() {
    try {
      const res = await acceptInvitation({ variables: { token: params.token } });
      const status = res.data?.acceptInvitation?.status;
      if (status) setResult({ status });
    } catch {
      // error is already surfaced via the `error` value from useMutation
    }
  }

  return (
    <div className="container" style={{ maxWidth: 480 }}>
      <h1>Accept invitation</h1>
      {!result && (
        <div className="card">
          <p>
            Click below to accept this invitation. The server will verify it was issued to the email address
            you&apos;re signed in with before adding you to the organization.
          </p>
          <button className="btn" onClick={onAccept} disabled={loading}>
            {loading ? "Accepting…" : "Accept invitation"}
          </button>
          {error && <p style={{ color: "var(--err)", marginTop: 10 }}>{error.message}</p>}
        </div>
      )}
      {result && (
        <div className="card">
          <p style={{ color: "var(--ok)" }}>You&apos;ve joined the organization as {result.status === "accepted" ? "a member" : result.status}.</p>
          <button className="btn" onClick={() => router.push("/dashboard")}>
            Go to dashboard
          </button>
        </div>
      )}
    </div>
  );
}
