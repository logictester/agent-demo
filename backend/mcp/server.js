import { FastMCP } from "fastmcp";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getLastTransfer, getTransactionHistory } from "../services/delegation.js";
import {
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
  runAutomationRuleNow,
  updateAutomationRule
} from "../services/automation.js";

let mcpServer = null;
let started = false;

function mcpEnabled() {
  return String(process.env.MCP_ENABLED || "true").toLowerCase() !== "false";
}

export async function startFastMcpServer() {
  if (started || !mcpEnabled()) {
    return;
  }

  const host = String(process.env.MCP_HOST || "127.0.0.1");
  const port = Math.max(1, Number(process.env.MCP_PORT) || 4011);
  const path = String(process.env.MCP_PATH || "/mcp");

  mcpServer = new FastMCP({
    name: "helio-banking-tools",
    version: "1.0.0"
  });

  mcpServer.addTool({
    name: "secure_transfer",
    description: "Execute a secure funds transfer between accounts.",
    parameters: z.object({
      amount: z.number().positive(),
      toAccount: z.string().min(1),
      fromAccount: z.string().optional().nullable()
    }),
    execute: async ({ amount, toAccount, fromAccount }) => {
      const transferAmount = Number(amount);
      return JSON.stringify({
        transactionId: uuidv4(),
        status: "completed",
        amount: Number(transferAmount.toFixed(2)),
        toAccount: String(toAccount).trim(),
        fromAccount: fromAccount ? String(fromAccount).trim() : null,
        source: "fastmcp"
      });
    }
  });

  mcpServer.addTool({
    name: "get_policy",
    description: "Return configured transfer policy and risk thresholds.",
    parameters: z.object({
      mediumRiskThreshold: z.number().nonnegative(),
      highRiskThreshold: z.number().nonnegative(),
      oobApprovalEnabled: z.boolean()
    }),
    execute: async ({ mediumRiskThreshold, highRiskThreshold, oobApprovalEnabled }) => {
      return JSON.stringify({
        riskLevels: ["Low", "Medium", "High"],
        mediumRiskThreshold: Number(mediumRiskThreshold),
        highRiskThreshold: Number(highRiskThreshold),
        stepUpRequired: true,
        outOfBandApprovalRequiredForHighRisk: Boolean(oobApprovalEnabled),
        source: "fastmcp"
      });
    }
  });

  mcpServer.addTool({
    name: "get_last_transfer",
    description: "Get most recent transfer for a user subject.",
    parameters: z.object({
      sub: z.string().min(1)
    }),
    execute: async ({ sub }) => {
      const lastTransfer = await getLastTransfer(String(sub).trim());
      return JSON.stringify({ lastTransfer, source: "fastmcp" });
    }
  });

  mcpServer.addTool({
    name: "get_transaction_history",
    description: "Get transaction history for a user subject.",
    parameters: z.object({
      sub: z.string().min(1),
      limit: z.number().int().positive().max(100).optional()
    }),
    execute: async ({ sub, limit }) => {
      const history = await getTransactionHistory(String(sub).trim(), Number(limit) || 10);
      return JSON.stringify({ history, source: "fastmcp" });
    }
  });

  mcpServer.addTool({
    name: "list_automation_rules",
    description: "List automation rules for a user subject.",
    parameters: z.object({
      sub: z.string().min(1)
    }),
    execute: async ({ sub }) => {
      const rules = await listAutomationRules(String(sub).trim());
      return JSON.stringify({ rules, source: "fastmcp" });
    }
  });

  mcpServer.addTool({
    name: "create_automation_rule",
    description: "Create automation rule for a user subject.",
    parameters: z.object({
      sub: z.string().min(1),
      rule: z.object({
        name: z.string().optional(),
        transferAmount: z.number().positive(),
        minAvailableBalance: z.number().nonnegative(),
        sourceAccount: z.string().min(1),
        destinationAccount: z.string().min(1),
        mode: z.enum(["scheduled", "on_demand"]),
        scheduleType: z.enum(["hourly", "daily", "weekly_n_times", "custom_interval", "specific_dates"]).optional(),
        scheduleConfig: z.record(z.any()).optional(),
        adaptiveConfig: z.record(z.any()).optional(),
        enabled: z.boolean().optional()
      })
    }),
    execute: async ({ sub, rule }) => {
      const created = await createAutomationRule(String(sub).trim(), rule || {});
      return JSON.stringify({ rule: created, source: "fastmcp" });
    }
  });

  mcpServer.addTool({
    name: "update_automation_rule",
    description: "Update automation rule for a user subject.",
    parameters: z.object({
      sub: z.string().min(1),
      ruleId: z.string().min(1),
      patch: z.object({
        name: z.string().optional(),
        transferAmount: z.number().positive().optional(),
        minAvailableBalance: z.number().nonnegative().optional(),
        sourceAccount: z.string().min(1).optional(),
        destinationAccount: z.string().min(1).optional(),
        mode: z.enum(["scheduled", "on_demand"]).optional(),
        scheduleType: z.enum(["hourly", "daily", "weekly_n_times", "custom_interval", "specific_dates"]).optional(),
        scheduleConfig: z.record(z.any()).optional(),
        adaptiveConfig: z.record(z.any()).optional(),
        enabled: z.boolean().optional()
      })
    }),
    execute: async ({ sub, ruleId, patch }) => {
      const updated = await updateAutomationRule(String(sub).trim(), String(ruleId).trim(), patch || {});
      return JSON.stringify({ rule: updated, source: "fastmcp" });
    }
  });

  mcpServer.addTool({
    name: "run_automation_rule",
    description: "Run an automation rule now for a user subject.",
    parameters: z.object({
      sub: z.string().min(1),
      ruleId: z.string().min(1),
      highRiskThreshold: z.number().nonnegative().optional()
    }),
    execute: async ({ sub, ruleId, highRiskThreshold }) => {
      const result = await runAutomationRuleNow(String(sub).trim(), String(ruleId).trim(), {
        highRiskThreshold: Number(highRiskThreshold)
      });
      return JSON.stringify({ result, source: "fastmcp" });
    }
  });

  mcpServer.addTool({
    name: "delete_automation_rule",
    description: "Delete an automation rule for a user subject.",
    parameters: z.object({
      sub: z.string().min(1),
      ruleId: z.string().min(1)
    }),
    execute: async ({ sub, ruleId }) => {
      const deleted = await deleteAutomationRule(String(sub).trim(), String(ruleId).trim());
      return JSON.stringify({ deleted: Boolean(deleted), source: "fastmcp" });
    }
  });

  await mcpServer.start({
    transportType: "httpStream",
    httpStream: {
      host,
      port,
      endpoint: path
    }
  });

  started = true;
  console.log(`[mcp] fastmcp server listening at http://${host}:${port}${path}`);
}
