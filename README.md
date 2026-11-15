# Browser MCP and AgentPilot for Siri

AgentPilot turns natural-language instructions into browser actions, such as opening an allowed website, filling a form, or checking page content. An AI agent uses browser tools exposed through the Model Context Protocol (MCP), inspects page snapshots, and verifies the result. The project includes local Python applications and an independent Cloudflare deployment.

With the Cloudflare version, Siri starts an Apple Shortcut that sends an instruction to the agent API using **Get Contents of URL** and an authorization token. The agent runs the task in a cloud browser and stores its status and evidence, so your computer can remain off. The initial response acknowledges submission; a separate status request retrieves the outcome. See the [Cloudflare README](cloudflare/README.md#simple-siri-shortcut) for the simple Shortcut structure and setup.

Run the deployed version with Siri, once the configuration is complete and shortcut is created, say 'Hey Siri, run AgentPilot' and provide a natural-language instruction. The agent will respond with a status and evidence of the task.

The repository separates the local Python applications from the Cloudflare deployment so each can be maintained independently.

| Folder | Purpose |
| --- | --- |
| `server` | Local Python MCP server exposing Playwright browser tools. Kept separate so different MCP clients can use it without the AI runner. |
| `agent` | Local Python AI runner that connects to the MCP server and carries out browser instructions using a model. |
| [`cloudflare/`](cloudflare/README.md) | Independent TypeScript cloud implementation containing the browser Worker, agent Worker, shared code, configuration, and verification scripts. Runs without the local Python applications or host computer. |
| `tests/` | Standalone Python browser smoke test, separate from application code and Cloudflare tests. |
| `.github/workflows/` | GitHub Actions configuration for verifying Cloudflare changes and optionally deploying both Workers. |

Within `cloudflare/`, `browser/` owns browser sessions and MCP tools, `agent/` owns task execution and results, `shared/` holds common contracts and instructions, and `scripts/` holds build and verification commands. Each Worker has its own configuration and tests to keep its responsibilities explicit.
