"use client";

// app/providers.tsx
//
// Wraps the whole app in NhostProvider (auth state) and NhostApolloProvider
// (GraphQL client that automatically attaches the user's JWT as
// Authorization: Bearer <token>, which is how Hasura derives
// X-Hasura-User-Id / X-Hasura-Role / X-Hasura-Allowed-Roles for every
// query/mutation/subscription — including the live-execution subscription).

import { NhostProvider } from "@nhost/react";
import { NhostApolloProvider } from "@nhost/react-apollo";
import { nhost } from "@/lib/nhost/client";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NhostProvider nhost={nhost}>
      <NhostApolloProvider nhost={nhost}>{children}</NhostApolloProvider>
    </NhostProvider>
  );
}
