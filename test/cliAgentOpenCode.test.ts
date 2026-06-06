import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { addAgent, AGENT_TYPES } from "../packages/cli/src/api/agents.js";
import { createAgentCommand } from "../packages/cli/src/commands/agentCommands.js";
import type { ApiClient } from "../packages/cli/src/api/client.js";
import type { ApiResponse } from "../packages/cli/src/api/types.js";

function response<T>(data: T): ApiResponse<T> {
  return {
    data,
    status: 200,
    headers: new Headers(),
  };
}

describe("CLI OpenCode agent support", () => {
  test("includes opencode in the supported agent type list", () => {
    assert.ok(AGENT_TYPES.includes("opencode"));
  });

  test("agent add command validation metadata includes OpenCode", () => {
    const agentCommand = createAgentCommand();
    const addCommand = agentCommand.commands.find((command) => command.name() === "add");

    assert.ok(addCommand);
    assert.match(addCommand.helpInformation(), /Agent type \(claude, codex, antigravity,\s+opencode, vibe\)/);
  });

  test("addAgent applies OpenCode Docker image and config path defaults", async () => {
    let postedBody: unknown;
    const client = {
      async get<T>(endpoint: string): Promise<ApiResponse<T>> {
        assert.equal(endpoint, "/api/config/agents");
        return response({ agents: [] } as T);
      },
      async post<T>(
        endpoint: string,
        options: { body?: unknown } = {}
      ): Promise<ApiResponse<T>> {
        assert.equal(endpoint, "/api/config/agents");
        postedBody = options.body;
        return response({
          success: true,
          agents: (options.body as { agents: unknown[] }).agents,
        } as T);
      },
    } as Pick<ApiClient, "get" | "post"> as ApiClient;

    const result = await addAgent(
      {
        alias: "opencode",
        type: "opencode",
        models: ["opencode/minimax-m3-free"],
      },
      client
    );

    assert.equal(result.success, true);
    assert.equal(result.agents.length, 1);
    assert.deepEqual(postedBody, {
      agents: [{
        id: result.agents[0].id,
        type: "opencode",
        alias: "opencode",
        enabled: true,
        dockerImage: "propr/agent-opencode:latest",
        configPath: "/root/.config/opencode",
        supportedModels: ["opencode/minimax-m3-free"],
        defaultModel: "opencode/minimax-m3-free",
      }],
    });
  });
});
