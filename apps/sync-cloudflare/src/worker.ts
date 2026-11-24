// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { handleRequest } from "./gate.ts";

export { AccountObject, RestoreMarker } from "./account-object.ts";

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
