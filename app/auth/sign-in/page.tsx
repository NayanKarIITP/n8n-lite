"use client";

import { useState } from "react";
import { useSignInEmailPassword } from "@nhost/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { signInEmailPassword, isLoading, isError, error } = useSignInEmailPassword();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = await signInEmailPassword(email, password);
    if (result.isSuccess) router.replace("/dashboard");
  }

  return (
    <div className="container" style={{ maxWidth: 380 }}>
      <h1>Sign in</h1>
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
        <button className="btn" type="submit" disabled={isLoading}>
          {isLoading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        No account? <Link href="/auth/sign-up">Sign up</Link>
      </p>
    </div>
  );
}
