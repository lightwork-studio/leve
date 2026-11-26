import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * Where a pairing link opens the app (`leve://connect?server=…&code=…`). Settings shows the
 * server it names and asks before connecting; nothing is connected from here.
 */
export default function Connect() {
  const { server, code } = useLocalSearchParams<{ server?: string; code?: string }>();
  return (
    <Redirect
      href={{ pathname: "/settings", params: { server: server ?? "", code: code ?? "" } }}
    />
  );
}
