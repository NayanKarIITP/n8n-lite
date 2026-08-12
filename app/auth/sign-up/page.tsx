"use client";

import { useState } from "react";
import { useSignUpEmailPassword } from "@nhost/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignUpPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { signUpEmailPassword, isLoading, isError, error, needsEmailVerification } =
    useSignUpEmailPassword();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = await signUpEmailPassword(email, password);
    if (result.isSuccess) router.replace("/dashboard");
  }

  return (
    <div className="container" style={{ maxWidth: 380 }}>
      <h1>Create account</h1>
      <form onSubmit={onSubmit} className="card">
        <div style={{ marginBottom: 10 }}>
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>Password</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        </div>
        {isError && <p style={{ color: "var(--err)" }}>{error?.message}</p>}
        {needsEmailVerification && (
          <p style={{ color: "var(--warn)" }}>Check your email to verify your account.</p>
        )}
        <button className="btn" type="submit" disabled={isLoading}>
          {isLoading ? "Creating…" : "Sign up"}
        </button>
      </form>
      <p>
        Already have an account? <Link href="/auth/sign-in">Sign in</Link>
      </p>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        After signing up, an owner must add you to an organization via <code>org_members</code>{" "}
        (see README &ldquo;Demo users/organizations&rdquo;) before you can see any workflows.
      </p>
    </div>
  );
}
