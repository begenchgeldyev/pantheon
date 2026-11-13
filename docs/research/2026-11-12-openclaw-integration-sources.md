# OpenClaw integration security sources

Research date: 2026-11-12. Research model: GPT-6.1 Sol Fast only.
Scope: documentation research, not deployment certification. Installed package
version was independently read as 2026.10.10; its bundled HTTP documentation
confirms the full-operator bearer warning, and bundled protocol/auth documentation
describes approved device-token scopes. No runtime authorization test was run.
Other live-doc details can differ from the deployed release. The coordinator independently retrieved sources
1 and 2 below with HTTP 200 and inspected their complete Markdown content.

## Verified primary-source findings

1. [Official trust model](https://docs.openclaw.ai/gateway/security/trust-model.md)
   - One Gateway is one trust boundary: one operator or mutually trusting team.
   - Mutually untrusted visitors should not share the owner's Gateway/agent.
     Official guidance requires separate Gateways, preferably OS users/hosts.
   - `sessionKey` is a routing selector, not an authorization token.
   - Whoever can message a tool-enabled agent shares its delegated authority.
   - Session visibility and agent-to-agent restrictions are useful guardrails,
     not strong tenant isolation. Send-only delegation can still ask a privileged
     agent to disclose information or act.

2. [Official Chat Completions endpoint](https://docs.openclaw.ai/gateway/openai-http-api.md)
   - `/v1/chat/completions` is disabled by default and runs normal agent turns.
   - The documentation explicitly calls it **full operator access** and says to
     keep it on loopback, tailnet, or private ingress, not the public internet.
   - Shared bearer credentials confer broad operator authority; a browser must
     never receive that secret. A narrower scopes header does not constrain a
     shared-secret caller in the currently documented implementation.
   - The `model` field selects an agent, not a provider model. Optional headers
     can override agent, session, and backend model. An application backend must
     build an allowlisted request, not forward arbitrary browser fields/headers.
   - A `user` string can derive a persistent conversation session. The server
     must authorize conversation ownership and select the routing value itself.
   - SSE streaming is supported. An error can arrive after partial text and before
     `[DONE]`; end-of-stream alone is not a successful agent result.
   - Client function-tool fields are not an internal OpenClaw tool-policy boundary.
   - Official guidance prefers HTTP for another operator/client surface; native
     direct clients can use paired-device WebChat/Gateway protocol instead.

## Additional specialist-researched references

The librarian consulted these official sources. Their version-specific details
remain implementation preflight checks, rather than verified deployment facts:

- [OpenResponses API](https://docs.openclaw.ai/gateway/openresponses-http-api.md):
  separately enabled HTTP endpoint, item-based input and SSE; investigate URL
  input fetching and ignored compatibility parameters before enabling features.
- [Tool policy](https://docs.openclaw.ai/gateway/config-tools/tool-policy.md):
  explicit deny-all and narrow allowlists; validate effective policy against the
  installed schema. A profile called `minimal` is not proof of zero tools.
- [Gateway protocol](https://docs.openclaw.ai/gateway/protocol.md) and
  [WebChat](https://docs.openclaw.ai/web/webchat.md): full control-plane transport,
  not automatically a narrow chat-only API. Pairing/scopes are release-specific.
- [Exposure runbook](https://docs.openclaw.ai/gateway/security/exposure-runbook.md)
  and [prompt injection](https://docs.openclaw.ai/gateway/security/prompt-injection.md):
  authenticate identity, restrict capabilities, isolate hosts, and assume model
  input can be manipulated. Prompts and origin checks are not authorization.

## Application implications

- Keep public portfolio CV chat separate from private personal gods.
- Owner-only access needs owner authentication on the actual chat endpoint,
  conversation authorization, browser-origin hardening, a narrow private backend
  boundary, hard deadlines/concurrency/spend limits, and redacted audit events.
- Prefer a distinct privileged origin rather than granting personal-agent access
  to a public page origin containing external scripts and author-supplied HTML.
- A public god demo should use original personas and public curated knowledge on
  an isolated deployment, with no owner memory, credentials, tools, or delegation.
- Before launch: match installed version/source; inspect effective tool policies;
  test anonymous/expired/forged access, cross-conversation access, header overrides,
  tool denials, streaming failures/cancellation, and secret-free browser traffic.

No endpoint was enabled, no configuration changed, and no agent turn was invoked.
