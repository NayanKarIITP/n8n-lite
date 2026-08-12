"use client";

import { useAuthenticationStatus } from "@nhost/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(isAuthenticated ? "/dashboard" : "/auth/sign-in");
  }, [isAuthenticated, isLoading, router]);

  return <div className="container">Loading…</div>;
}
