---
title: Protocol messages
description: WebSocket message reference for KiCI tiers -- Platform, orchestrator, agent, dashboard, peer-to-peer
---

KiCI tiers communicate over WebSocket using Zod-validated message envelopes. The complete message reference is split across three pages.

| Page                                                        | Covers                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Overview](./protocol/overview.md)                          | Message flow, common envelopes, authentication.                                                                                                                                                              |
| [Orchestrator ↔ Agent](./protocol/orchestrator-agent.md)    | Job dispatch, cancel, registration, log streaming, job / step status, heartbeats, cache upload, provenance attestation upload, event emit, fleet log collection, step approval, execution status forwarding. |
| [Dashboard, metrics & wire format](./protocol/dashboard.md) | Concurrency events, agent metrics, agent authentication, agent private API, join, peer-to-peer, the test-relay control plane, wire format, validation, and request tracing.                                  |

## See also

- [Webhook delivery flow](./webhooks/webhook-delivery.md) -- end-to-end trace of a webhook through all three tiers
- [Architecture overview](./overview.md) -- high-level three-tier architecture
- [Orchestrator configuration](../operator/orchestrator/configuration.md) -- orchestrator deployment settings
- [Agent configuration](../operator/agent/configuration.md) -- agent deployment settings
