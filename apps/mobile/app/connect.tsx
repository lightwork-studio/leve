import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * Where a pairing link opens the app (`leve://connect?server=…&code=…`). Settings shows the
 * server it names and asks before connecting; nothing is connected from here.
 */
export default function Connect() {
  const { server, code } = useLocalSearchParams<{ server?: string; code?: string }>();
  return (
    <Redirect
      href={{
        pathname: "/settings",
        // When it was opened, so the same link opened again asks again.
        params: { server: server ?? "", code: code ?? "", opened: String(Date.now()) },
      }}
    />
  );
}
