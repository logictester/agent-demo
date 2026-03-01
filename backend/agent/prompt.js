export const POLICY = {
  mediumRiskTransferThreshold: Number(process.env.RISK_MEDIUM_THRESHOLD) || 100,
  highRiskTransferThreshold: Number(process.env.RISK_HIGH_THRESHOLD) || 500,
  riskLevels: ["Low", "Medium", "High"]
};

export const CAPABILITIES = [
  {
    intent: "transfer_funds",
    operationKey: "transfer_funds",
    description: "Transfer funds to a target account.",
    argsSchema: {
      amount: "number",
      toAccount: "string",
      fromAccount: "string (optional)"
    }
  },
  {
    intent: "view_identity",
    operationKey: "view_identity",
    description: "Explain verified token-based identity details."
  },
  {
    intent: "view_last_transfer",
    operationKey: "view_last_transfer",
    description: "Summarize the most recent successful transfer in this session."
  },
  {
    intent: "view_transaction_history",
    operationKey: "view_transaction_history",
    description: "Retrieve persisted transaction history for the authenticated user."
  },
  {
    intent: "manage_automations",
    operationKey: "manage_automations",
    description: "Create, edit, list, or execute balance-based automated transfer rules through prompts.",
    argsSchema: {
      action: "string (optional: create_rule|update_rule|run_rule|list_rules|cancel)",
      ruleName: "string (optional)",
      transferAmount: "number",
      minAvailableBalance: "number",
      intervalMinutes: "number (optional)",
      scheduleType: "string (optional: hourly|daily|weekly_n_times|custom_interval|specific_dates)",
      scheduleConfig: "object (optional)",
      sourceAccount: "string (optional)",
      destinationAccount: "string (optional)",
      adaptiveConfig: "object (optional: { rules:[{ whenBalanceBelow, transferAmount }] })",
      runNow: "boolean (optional)"
    }
  },
  {
    intent: "explain_policy",
    operationKey: null,
    description: "Explain transfer risk and authentication policy."
  },
  {
    intent: "general_question",
    operationKey: null,
    description: "General non-operational question."
  }
];

export const SYSTEM_PROMPT = `
You are a banking AI assistant integrated with a backend policy engine.
Never fabricate backend actions or data.
Always respect policy facts supplied in prompt context.
When data is unavailable, state that clearly.
`;
