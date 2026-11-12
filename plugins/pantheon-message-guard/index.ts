import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { validateMessage } from "./validator";

export default {
  id: "pantheon-message-guard",
  name: "Pantheon Message Guard",
  register(api: OpenClawPluginApi) {
    api.on("before_tool_call", event => validateMessage(event.toolName, event.params), { matcher: ["message"] });
  },
} satisfies OpenClawPluginDefinition;
